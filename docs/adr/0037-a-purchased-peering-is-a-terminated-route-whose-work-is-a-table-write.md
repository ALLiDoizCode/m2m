# A purchased peering is a terminated route whose work is a table write

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

Issue #885 (toon-meta#310, child C2 of #867 "sell peering") prices issue #884's runtime
peer/route mutation and advertises it in kind:10032. This ADR states the shape the purchase
takes, the arithmetic it enforces, and what it deliberately leaves for later work rather than
half-building.

## Context

#867's idea: a connector sells peering, a priced destination that, paid, inserts the payer into
this node's routing table. #884 (ADR 0034) built the mutation primitive
(`Connector::upsert_runtime_peer`/`upsert_runtime_peer_route`) but wired no pricing and no
purchase path — "pricing... is C2's job, not this child's." #885's own text settles the
design fork #867 raised (issued bearer token vs. signature challenge) as moot: a peer-wire
claim's signature already proves identity against the channel's configured counterparty
(`ClaimBook::verify_signature`), so `{peerId, secret}` has no job left. Do not implement a
token.

**What "the payment names the channel it is binding" means, concretely.** A buyer pays the
peer-sale route as an ordinary client purchase — the same shape `pay_the_through_url`
(`crates/connector-cli/src/announce.rs`) already exercises against a node it has no peering
with. The client edge admits that payment by resolving and chain-verifying the client channel
the covering claim names (`ClientChannelRegistry`, issue #556/#941), and threads that channel's
key through as `client_channel_id` (ADR 0036, `evm:<id>` / `solana:<account>`). **That channel
_is_ the binding** — nothing in the purchase names a second, self-declared `channelId` for this
connector to trust blindly. This is stronger than the issue's own citation
(`claim.rs:441-462`, which is peer-wire verification): it is the client-edge channel
resolution that already existed for #941, reused rather than re-invented.

## Decision

**The peer-sale route is a terminated route whose "app" is this connector's own runtime, not an
HTTP handler.** `[peer_sale]` is a new, singleton config section (`prefix`, `price`) —
singleton because a node sells exactly one peering offer at one price, unlike `[[routes]]`'s
array of independent app/peer destinations. It participates in the _same_ longest-prefix
routing table, the same `client_route` lookup, and the same x402 greeting/claim-gate/pricing
path (ADR 0028) as every other route — `ClientRouteKind::Terminated`, ranked like a config app
route (`RouteRank::App`) — so nothing downstream of routing needs to know a third route kind
exists. What differs is only the _delivery_ step: `Connector::deliver_peer_sale` opens the ADR
0018 gift wrap exactly like `deliver_to_app`, but instead of an HTTP round trip, decodes the
buyer's JSON purchase terms and performs the table write directly.

**The channel that pays is the channel that is bought in.** `deliver_peer_sale` requires
`client_channel_id` (threaded from `handle_prepare_with_client_channel`, previously used only
for the ADR 0036 tracing span — now also load-bearing for routing). It re-reads that channel
fresh from its settlement backend (`Connector::settlement_for_channel` +
`SettlementBackend::channel_state`) before writing anything: the client edge already proved the
claim's signer against it once, to admit the payment; this guards against the channel having
gone terminal (or never existed, for a caller that reaches `handle_prepare` directly rather than
through the client edge) in the window between that admission and this delivery, rather than
trusting a string across that boundary. A channel that does not resolve, or whose status is not
`Open`, is refused (`F00_bad_request`) with a `tracing::warn!` naming the channel id and the
reason — never silently. The channel key itself becomes the new peer's id: unique, stable, and
needing no buyer-chosen name to collide over.

**The buyer names the new route's terms; this connector enforces one arithmetic bound.** The
purchase body is `{ prefix, fee, price, next_hop_price }` — the peer-forwarding route the buyer
wants inserted (their own destination prefix, what this connector retains per packet, what this
connector's clients pay to reach them), plus what the buyer itself declares it needs delivered
to relay a packet onward. `price.checked_sub(fee) >= next_hop_price` is checked before any
write; failing it (including `fee > price`, which is refused rather than underflowing) refuses
the purchase with the numbers named in the message. This is #885's own acceptance criterion,
made checkable only because the purchase — unlike an ordinary `[[routes]]` forwarded route —
puts `next_hop_price` in this connector's hands: ADR 0028 could not enforce this same bound
generally ("it cannot, without knowing the far end's price"); a purchase can, because the far
end just told it.

**Advertised unconditionally, not opt-in-per-address.** `connector-cli`'s `build_announcement`
adds the peer-sale prefix's price to kind:10032's `routePrices` regardless of whether an
operator also remembered to list it in `[announce].addresses` — the whole point of pricing the
mutation is that a buyer discovers it without asking a human, so discoverability cannot depend
on a second config line nobody is told to write.

## What this deliberately does not do

**No token, no credential, no session-scoped secret.** Settled by #885's own text; restated here
because this ADR is downstream of that decision, not because it is re-litigated.

**No lease, no expiry, no abuse bounds.** #886 (C3) and #887 (C4) own those. A purchased peering
inserted here is a permanent grant, exactly like any other operator-written `[[routes]]` row,
until a later child adds a TTL or a cap. Nothing here forecloses either.

**No `ClaimBook` peer-channel registration, and no change to peer-carriage accept-side
authentication.** This is the one place this ADR's scope stops short of #885's "the buyer can
immediately forward over the new peering" acceptance criterion, and it is worth stating plainly
rather than leaving a reader to discover it by tracing code:

- `ClaimBook`'s peer-wire verification state (`counterparties`, `channel_domains`,
  `solana_channels`) is populated only at boot, from `[[peer_channels]]`, and every setter that
  reaches it takes `&mut self` — there is no runtime-mutation path onto it today, unlike the
  `ArcSwap`-backed peer/route table #884 built. Making a purchased channel's claims verifiable
  on the peer wire needs that capability built first.
- `peer-carriage-spec.md` §1.2 states role as P2 (a `[[peer_channels]]` binding) + P3 (claim
  signature) — but the code that decides an _inbound_ interaction's role
  (`connector-peer-auth::decide_role`) still gates on its own P1 (a `{peerId, secret}` bearer
  credential from `[[peers]]`) **and** P2, with no P3 check at role-decision time at all. Issue
  #868 — open, not part of this ticket, with its own ADR-requiring acceptance criteria
  ("`peer-carriage-spec.md` §1.2/§1.3/§1.5 updated: role from P2 + claim signature") — is what
  retires that gate. Verified by reading `crates/connector-peer-auth/src/decision.rs` directly
  rather than trusting the spec prose, per this repo's own "vectors (and code) are normative,
  prose drifts" doctrine (ADR 0021's principle, applied to an implementation gap rather than a
  wire encoding).

Both gaps are pre-existing and orthogonal to #885: #884 already shipped a runtime routing-table
write with no live carriage wired to it (ADR 0034's own "Consequences" section says so for the
_outbound_ direction), and #868 covers the credit-window/role-decision rewrite that would close
the inbound one. Building either into #885 would mean redesigning `ClaimBook`'s internal
mutability and/or `connector-peer-auth`'s stop-ship role invariant under a ticket titled
"price the mutation and advertise it" — scope creep into two separably-reviewable,
security-sensitive changes that already have (or need) their own ADRs. What #885 _does_ ship —
the priced purchase, the channel verification, the arithmetic bound, the table write, the
announce — is real and independently useful: `client_route`/`select_configured_route` resolve
and price traffic to a newly-purchased prefix immediately (proven at the `Connector` level,
matching #884's own testing altitude), and the row is durable and inspectable
(`GET /peers`/`GET /routes/peers`, `source: "runtime"`) the moment the purchase clears.

## Consequences

- A node that never configures `[peer_sale]` behaves exactly as before this issue — the section
  is optional and additive, like `[peer_channels]`/`[client_channels]` before it.
- The next reader wiring #868 has a concrete list of what "peer role rests on P2 alone" still
  needs: retire `connector-peer-auth`'s P1 check, and give `ClaimBook` a runtime-mutable
  counterpart to `set_verification_key`/`set_channel_domain`/`set_solana_channel` (the C1-style
  `ArcSwap` pattern, not a `&mut self` boot-time setter) so a purchased channel's claims verify
  on the peer wire without a restart.
- A future purchase-time credential is still off the table even once #868 lands: the point of
  #885/#868 together is that a claim signature is the credential. Nothing in this design
  reintroduces a place for one.
