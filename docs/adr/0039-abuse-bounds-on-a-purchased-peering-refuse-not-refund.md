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
  successful or not — a fixed-window limiter (`PurchaseRateLimiter`) with the same shape
  `ProbeRateLimiter` already has for probe traffic, kept as a separate instance so a flood against
  one budget cannot starve the other's.

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
convention.

**Ordering: cheapest first, chain read last.** The rate limit is checked before the purchase body
is even parsed (bounding attempts, not only well-formed ones — a flood of garbage bodies is
throttled rather than parsed and judged every time). The row and length caps run after the
existing containment/arithmetic checks and before `verify_purchasing_channel_open`'s chain read —
a purchase a bound was always going to refuse never pays for that read.

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

**Identity-keyed bounds run after, and this is structural.** The remaining bounds are all about
_this payer's_ history: the per-payer route cap
and the purchase rate limit obviously so, and the total-row cap because it is deliberately not
applied to a payer that already holds a row (a renewal never grows the table), which is a fact
about the payer's identity like the other two. And the payer's identity does not exist as a
checkable fact until
`connector-client-edge::ClientClaimGate::admit` has verified the claim's signature against its
channel, which is the same operation that advances the watermark. There is no cheaper "peek the
verified identity" step to call first — this codebase's one precedent for judging identity ahead
of full admission (`connector-client-edge::lookup_budget`, issue #613) does so with the claim's
_self-declared, unverified_ signer, explicitly "a label for grouping and attribution, never a
credential," and accepts the residual weakness that an adaptive sender can declare a fresh label
per attempt. Extending that same weak-identity idiom to this issue's row cap and rate limit was
considered and set aside for this pass: it would only protect a payer who _truthfully_ declares
its own identity pre-admission, since a payer set on bypassing it can always declare something
else and pay through to the authoritative post-admission check regardless — and it would need the
same weak identity threaded through both HTTP and BTP carriages in `connector-client-edge` to reach
a `connector-runtime` bound it does not otherwise need to know about.

**Net effect, stated plainly:** a malformed body, an invalid or config-shadowing prefix, an
arithmetic shortfall, or an over-length prefix now refuses with **nothing charged** — the claim
is never admitted, and the refusal message is byte-identical to the paid path's. What remains
charged-then-refused is the identity-keyed set: the purchase rate limit, the per-payer route
cap, the total-row cap (identity-keyed because a renewal never grows the table), and the
on-chain channel-state re-check. That residual window is qualitatively different from the one
the review found: it is reachable only by a payer spending against **their own** channel, its
frequency is bounded by this ADR's own rate limit, and every such charge is visible in the
claim journal. Closing it too needs either the credit-refund ledger (#709) or a purpose-built
pre-admission identity peek carried through both carriages — a separable, security-relevant
change better scoped on its own ticket than folded into a bounds-and-defaults issue.

## Consequences

- A node that never writes `[peer_sale]` is unaffected: bounds are consulted only when a peer-sale
  route exists and a purchase actually matches it.
- `docs/adr/0037-...`'s "config-owned address space is not for sale" and its arithmetic bound are
  restated here as already satisfying #887's own containment acceptance criterion ("a purchased
  prefix cannot shadow a config-file prefix unless the precedence rule from C1 explicitly
  permits it") — no new code was needed for that bullet, only this record connecting it to #887.
- The next reader closing the "before payment" gap fully has two named options above (#709, or a
  self-declared pre-admission identity peek modeled on `lookup_budget`) rather than an open
  question.
