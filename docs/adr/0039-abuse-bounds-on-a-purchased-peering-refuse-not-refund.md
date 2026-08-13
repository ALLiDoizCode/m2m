# Abuse bounds on a purchased peering refuse, not refund

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

Issue #887 (toon-meta#316, child C4 of #867 "sell peering") bounds issue #885's priced write
primitive: row caps, a prefix-length cap and a purchase-attempt rate limit, each with a tight
default, each configurable, each refused loudly. This ADR states where each bound is enforced,
why two tables are capped rather than one, and what "refuses before taking payment" does and does
not cover here.

## Context

#885 (ADR 0037) made buying peering a priced write with two guards already in place: config-owned
address space cannot be bought into (`config_owns_ancestor_of`), and the buyer's own arithmetic
must cover its declared next hop (`covers_next_hop`). Neither bounds _quantity_: nothing stopped
one payer from buying an unbounded number of prefixes, nothing stopped an unbounded number of
distinct payers from each buying one, nothing bounded how long a purchased prefix string could be,
and nothing rate-limited how often a payer could try. #887's own framing: "a write primitive
exposed to the network... a way to fill a box's disk and its routing table for the price of a lot
of very small payments."

## Decision

**Two tables, two different caps, because a per-payer cap only means something on one of them.**
A "peer row" is an entry in the runtime _peer_ table (`Connector::runtime_peers`) — one per
distinct payer, because a channel can only ever buy itself one peer identity: `peer_id` IS the
channel key that paid (ADR 0037). A per-payer cap on that table would always evaluate to 0 or 1
and bound nothing. What a single payer _can_ grow without bound is how many _routes_ (prefixes) it
buys, all forwarding to the one peer id it holds. So:

- `max_purchased_rows` bounds the peer table globally: how many distinct payers may hold a
  purchased peering at once.
- `max_routes_per_payer` bounds the route table per payer: how many prefixes one payer's peer id
  may have inserted.
- `max_prefix_length` bounds a single purchased prefix's byte length — tighter than
  `connector_domain::is_valid_ilp_address`'s own 1023-byte RFC ceiling, which still applies to
  every ILP address; this is this node's own choice about how much of that allowance a _purchase_
  gets to spend.
- `purchase_rate_limit` / `purchase_rate_window_seconds` bound purchase _attempts_ per payer,
  successful or not — the same `FixedWindowRateLimiter` probe traffic already uses, held as a
  second, separate instance so a flood against one budget cannot starve the other's.

Every bound has a default (`connector-config::peer_sale`'s own constants — 32 rows, 4 routes per
payer, 128-byte prefixes, 5 attempts per 60 seconds), is configurable via `[peer_sale]`, and is
active even when an operator never writes the section: `Connector::new` populates
`PeerSaleBounds::default()` unconditionally, the same "fails closed" shape `probe_rate_limiter`
already takes, so a forgotten limit is a tight one rather than none.

**A row cap never blocks a renewal.** Posting the same prefix again is `upsert_runtime_peer_route`'s
own update-not-duplicate shape (#884); neither the total-row cap nor the per-payer route cap
applies to a purchase that only restates a row its own payer already holds, since that purchase
never grows either table.

**Every refusal is loud.** Each bound's refusal is a `tracing::warn!` naming the payer's channel
id and the specific number and limit it hit, and the same information rides the packet's own
REJECT message — matching #885's own existing containment/arithmetic refusals, not a new
convention. A shape refusal reached with no claim admitted (the ordinary path for one, per the
section below) has no payer to name and logs `<unadmitted>` rather than inventing one.

**Ordering: unpaid refusals first, chain read last.** `settle_peer_sale_purchase` parses the
purchase body and runs every shape-derived refusal (`peer_sale_shape_refusal`, including this
issue's length cap) before it so much as looks at which channel paid — the order the section
below requires, so the answer is identical whether or not a claim was admitted. The rate limit
and the row caps come next, keyed by that channel; they meter _judged_ attempts, so a malformed
body no longer occupies a payer's rate-window slot (it is refused unpaid, above). All of it
precedes `verify_purchasing_channel_open`'s chain read, so a purchase a bound was always going
to refuse never pays for that read.

## What "before taking payment" covers here, and what it does not

#887's acceptance text: _"Hitting a bound refunds or refuses BEFORE taking payment — do not take
money and then decline the insert."_ This connector has no refund/credit-back mechanism (#709,
"serving claimless packets against banked surplus", is not built) — so the answer is **refuse**,
not refund, restated from #885's own precedent rather than invented here.

**Where this ADR's bounds actually run.** They split along one line: whether the refusal is
derivable from the packet alone, or only from the payer's proven identity.

**Shape-derived refusals run BEFORE payment.** `Connector::peer_sale_purchase_would_be_refused`
extends the exact pre-admission seam issues #869/#944 built for envelope-target refusals: the
client edge consults it (both carriages) before `ClientClaimGate::admit`, and when it answers
`true` the claim is left entirely unadmitted — routing still runs, and
`settle_peer_sale_purchase` re-derives the identical refusal from the same shared
`peer_sale_shape_refusal` function, so the two sides can never disagree and no watermark moves.
This covers everything judgeable from the request alone: an unparseable body, an invalid prefix,
a config-shadowing prefix (ADR 0037), an arithmetic shortfall, and this issue's prefix-length
cap. A stranger without so much as a channel can no longer cause a single charged refusal with
any of them.

**Identity-keyed bounds refuse before payment too, via the declared-channel peek.** The
remaining bounds are all about _this payer's_ history: the per-payer route cap and the purchase
rate limit obviously so, and the total-row cap because it is deliberately not applied to a payer
that already holds a row (a renewal never grows the table). Their pre-admission check
(`Connector::peer_sale_purchase_refusal_for_payer`, consulted by both carriages) reads the claim
header's **own declared channel key** without validating or admitting the claim — and unlike
`lookup_budget`'s weak-identity label (issue #613), this is sound as a refusal basis, for a
reason specific to how these bounds bind: admission verifies the claim's signature against
exactly the channel the claim declares, so a sender declaring any _other_ channel is rejected at
admission and charged nothing regardless. The peek is therefore accurate for every payer who can
actually be charged; lying about the key buys nothing but an unpaid rejection. The rate check in
the peek is a pure read (`would_allow`): a refusal that charges nothing costs the payer none of
their window either, and only judged, charged attempts count. `settle_peer_sale_purchase`
re-derives the same answer post-admission from the same shared function — the authority for
direct callers and for races into the window between peek and admission.

**Net effect, stated plainly:** every bound this ADR names — shape-derived and identity-keyed
alike — refuses with **nothing charged**: the claim is never admitted, and the refusal message is
byte-identical to the paid path's. What remains charged-then-refused is exactly one check: the
on-chain channel-state re-read (`verify_purchasing_channel_open`), which cannot move
pre-admission without putting an RPC on the unpaid path — the #613 anti-pattern this codebase
built the channel index to remove. That residual window is reachable only by a payer whose own
channel went terminal between claim and delivery, and every such charge is visible in the claim
journal. A post-admission race into the rate window or a cap (two purchases from one payer in
flight at once) can still charge the loser; the credit-refund ledger (#709) is the named remedy
if that ever matters in practice.

## Consequences

- A node that never writes `[peer_sale]` is unaffected: bounds are consulted only when a peer-sale
  route exists and a purchase actually matches it.
- `docs/adr/0037-...`'s "config-owned address space is not for sale" and its arithmetic bound
  satisfy #887's own containment acceptance criterion ("a purchased prefix cannot shadow a
  config-file prefix unless the precedence rule from C1 explicitly permits it") — with one
  addition this issue did need: the `[peer_sale]` prefix itself now counts as config-owned in
  both anti-shadowing guards, since it is as much a config-file route as any `[[routes]]` row,
  and omitting it let a buyer purchase a prefix beneath the sale address and outrank the sale
  route for its whole subtree.
- The declared-channel peek is now the codebase's second pre-admission identity idiom, distinct
  from `lookup_budget`'s (#613): there the label is attribution-only and lying wins slack; here
  the label is the charged channel itself and lying buys an unpaid rejection. A reader extending
  either should keep that distinction — the peek idiom is sound only where admission binds the
  same declared value it verifies.
- The one refusal still on the paid side is the on-chain channel-state re-read; #709's
  credit-refund ledger is the named remedy for it (and for post-admission races into a bound)
  if either ever matters in practice.
