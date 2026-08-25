# A packet carries its claim

**Status:** Accepted — **a target record, partly built**. **Supersedes [0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md)**, retires [0004](0004-value-moves-on-fulfilment.md)'s headline, and amends [0010](0010-flat-per-packet-fee-and-minimum-delivery.md) and [0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md). Built: the cap (`max_packet_amount`, with a default), the send half (`[[pay_channels]]` populating `outbound_client_hops`, issue #881), and — issue #1142 — the rule that a **forwarded** arrival must carry a covering claim, which ships **defaulting to observe** per peering and so does not yet bind a deployed box. (`ClaimEnforcement::Observe` was the _other_ item listed here; it is resolved — **deleted**, issue #1062 — and it never governed forwarded arrivals in the first place, since `payment_required` filtered to `ClientRouteKind::Terminated`. The two debts were independent and this line used to read as though they were one.) Until an operator writes `forwarded_claim_enforcement = "enforce"`, forwarding still runs [0004](0004-value-moves-on-fulfilment.md)'s model end to end.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

Every packet carries the claim that pays for it. A PREPARE arrives at a connector with a covering
claim or it is refused, whether that connector will forward it or terminate it; and a connector
covers every PREPARE it sends. A **fulfilment proves that the intended receiver got the packet**
and nothing else — it is a delivery receipt, not a payment trigger. Value in flight is therefore
at risk, and bounding that risk is the **sender's** business rather than the protocol's: small
packets, and larger ones only on a path that has earned them.

## What this supersedes

**[ADR 0004](0004-value-moves-on-fulfilment.md)'s headline is retired.** "Value moves on fulfilment
and only on fulfilment" conflated two questions — _when is value owed_ and _what proves delivery_ —
and answered both with the fulfilment. This record keeps only the second. What survives from 0004 is
untouched: **one claim per packet, never batched**, and `lockedAmount`/`locksRoot` stay dead.

**[ADR 0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md) is superseded
entirely**, not amended. It stated this rule for the peer role alone, and every clause of its
Decision was false of the shipped binary: an uncovered arrival was refused only at a _priced
termination_ (a forwarded destination prices at `0` and is admitted free); no connector has ever
covered a PREPARE it sends, because issue #881's proactive covering was never wired to config;
`ClaimEnforcement::Observe` is an escape hatch it claimed did not exist; and the credit window it
declared "gone as an operating mode" is the only mode that runs. Four false clauses is past the
point where amendment banners help a reader.

**[ADR 0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md) loses one inherited
property.** Its "understating a fee is unprofitable — honesty needs no enforcement" was reasoned
from ADR 0004's postpay: a hop advertising a low fee and then rejecting earned nothing. Under this
record it banks the claim instead, so fee honesty becomes bounded rather than self-enforcing — by
packet size and by the cap below. ADR 0011 carries the amendment; nothing else in it changes, probe
economics included.

## The trade this makes, and does not hide

ADR 0004 rejected prepay on a specific argument: prepayment makes the execution condition
economically inert, because "a hostile next hop takes the claim and rejects the packet… Trustless
forwarding and prepayment cannot both be true."

**That argument is correct, and this record overrides it deliberately.** ADR 0031 asserted the
argument "remains sound and is not disturbed here" while doing precisely the thing it forbids; the
inversion was real and went unstated. Stating it: under this record the condition stops being an
economic guarantee and becomes a delivery proof. A hop can take a claim and refuse to carry.

What answers the objection is not a protocol guarantee but two bounds, and Interledger has always
worked this way:

- **A per-peer cap** on the amount carried in one packet (below), which is the most a single theft
  can take.
- **The sender's own packet sizing.** RFC 0018: smaller payments carry proportionally less risk —
  "in ILPv4, this is the default." RFC 0027 designs for "large volumes of low-value packets."

RFC 0027 does not say when ledger value moves relative to the packet — "payment channels are only
used for funding and rebalancing… not directly part of the ILPv4 packet flow" — so both this record
and ADR 0004 were always protocol-legal. This is a local choice, made because a hop that is paid
before it carries can always decline to carry, and no amount of protocol prevents that — only a
bound on what one packet is worth does.

An earlier draft of this record justified the cap by saying a peering "may have been bought", so a
counterparty that selected itself is owed no credit.
[ADR 0043](0043-purchasable-peering-is-removed.md) removed that premise outright: a peering cannot
be bought, so every peer is operator-chosen. **The cap is unaffected** — it is the dial law 03's "trust grows" turns for
_every_ peer, not a guard against self-admitted ones.

## The cap

**Every peering carries a maximum amount this connector will forward to it in one packet.** A packet
needing more is refused with `T04` — never carried, never split. The cap is how far a connector
trusts a peer, expressed as the most it is willing to lose at once: a new peering starts at the
floor; a path that keeps fulfilling earns a larger one.

It has a default, so an operator who never configures one is still bounded. A bound only an
attentive operator gets is not a bound.

This is not [ADR 0033](0033-the-exposure-machinery-is-retired-not-restated.md)'s ceiling returning.
That bounded an _accumulation_, and under this record no accumulation exists — a packet carries its
own claim, so nothing is ever owed between packets. The cap bounds **one packet**. ADR 0033 stands
as written, and its premise (that a covering claim bounds every peering) becomes true for the first
time once the work below lands.

## What must be true for this record to be true

None of this ships today. Listed in the order it must be built, and the order matters for one
reason only — the third item is the one that can break a running fleet:

1. **The cap, refused with `T04`, with a default.** Independent of the rest, and safe to land on its
   own: it only ever refuses a packet this connector would otherwise have carried.
2. **Wire issue #881 — the send half.** ~~Proactive covering exists in the runtime and is exercised by
   tests, but no production path populates `outbound_client_hops`.~~ **Built.** `[[pay_channels]]`
   populates `outbound_client_hops` from `connector-cli`'s own build chain, one row per peering this
   node pays: the channel, its EIP-712 domain, and that hop's client edge as the watermark authority
   (asked over `POST /ilp/claim-state` on every covered packet, never remembered). Additive as
   promised: a peering with no row behaves exactly as it did — `cover_forward` answers
   `NotConfigured`, the postpay `pending_claim` path runs, and no outbound client ledger file is
   opened at all.
3. **Require a covering claim on forwarded arrivals.** ~~The price gate filters on
   `ClientRouteKind::Terminated`, so a packet this connector forwards onward is carried for free.~~
   **Built, and defaulting to observing.** `price_gate::payment_required` now judges a
   `ClientRouteKind::Forwarded` arrival too, against **the packet's own `amount`** — not a price and
   not the fee. That is the symmetric figure: the send half covers the next hop for
   `amount_after_fee(amount, fee, minimum_delivery)`, so an upstream peer covering the amount that
   arrives here leaves this connector exactly its flat fee ([ADR
   0010](0010-flat-per-packet-fee-and-minimum-delivery.md)). The advance is measured against the channel's prior
   watermark by the same `validate_price` the terminated rule uses, and an unaccepted claim advances
   nothing however much it declares.

   **This one is breaking, so it is off by default.** It ships behind a **second** per-peer knob,
   `forwarded_claim_enforcement` (`connector_config::ForwardedClaimEnforcement`), separate from
   `claim_enforcement` and defaulting the other way: **`"observe"`** — the arrival is admitted and
   forwarded, and logged exactly as a refusal would be logged. An operator flips one peering to
   `"enforce"` once that peering's counterparty is covering its forwards. Two settings rather than
   one restructured setting, because the two migrations default in opposite directions and end on
   different days: the terminated migration's escape hatch is dated for deletion and has since been
   deleted (the Update below, issue #1062), and folding the two together would have deleted this
   item's default along with it. The terminated rule ([ADR
   0029](0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md)) is unchanged
   under every combination of the two.

   **Not covered by this item:** a destination reached over a **leased** route. `Connector::client_route`
   excludes leases by construction (ADR 0028, and ADR 0029's "leased routes are unaffected"), so a
   leased arrival is neither priced nor gated here — it is the same hole ADR 0028 already names, not
   the `Terminated` filter this item was about, and closing it is separate work.

4. **Resolve `ClaimEnforcement::Observe`** — honour its 2026-11-01 sunset, or record that the escape
   hatch is permanent.

Until (2) lands the connector runs ADR 0004's model end to end for forwarding, which is coherent and
RFC-shaped; it is simply not this record. **Three documents already assert otherwise** — ADR 0031's
Decision, ADR 0033's premise, and `docs/protocol/money-model-pre-868.md`'s "current behaviour" banner. This
record does not become a fourth: it says plainly that it describes the target.

(2) has since landed, and what it changed is narrower than "the fleet now covers": a peering covers
its forwards **once an operator writes `[[pay_channels]]` for it**, and no committed config on this
fleet writes one yet. So the sentence above still describes every deployed box, and stops describing
one the moment its config names a channel to pay from.

(3) has since landed too, and changes nothing about a deployed box until an operator writes
`forwarded_claim_enforcement = "enforce"` on a peering. Until then a forwarded arrival is admitted
and logged, which is what makes the order above survivable: the receive half can roll out fleet-wide
while the send halves are still being configured, and each peering closes when its own counterparty
is ready.

## Consequences

**The app is never a hop.** Claims ride client-to-connector and connector-to-connector links only.
The app holds no channel, settles nothing, and is handed ordinary HTTP that was already paid for.

**Trust buys packet size, never deferred payment.** A well-trodden path earns a larger cap. It never
earns the right to owe — batching and credit windows stay retired, because that is what would put an
accumulation back.

**A signature sits on the hot path of every packet at every hop**, as ADR 0004 already noted. That
cost is now permanent rather than provisional, and is what this record buys: no peering is ever owed
anything between packets, so no peering can be left holding value a counterparty declines to cover.

## Update (issue #1062) — `ClaimEnforcement::Observe` is deleted, and it was never the forwarded half

This record's Status line listed two unbuilt items together: requiring a covering claim on
**forwarded** arrivals, and the resolution of `ClaimEnforcement::Observe`. **They are independent, and
listing them together was misleading.** `connector_peer_btp::price_gate::payment_required` filters to
`ClientRouteKind::Terminated`, so `Observe` only ever governed the ADR 0029 price gate at a terminated
route. It never touched forwarding.

### `Observe` is deleted

It was a migration ramp and said so — _"Migration-only (issue #883): the packet is admitted exactly as
it was before issue #880, but logged so an operator can confirm real admissions before flipping this
peering to enforce."_ Its own type documentation carried a dated sunset: delete once every `[[peers]]`
row reads `Enforce` and the rollout runbook confirms it, no later than 2026-11-01.

**Both preconditions were already met.** No committed configuration sets it — the single occurrence is
a commented-out example in `deploy/connector-rust/connector.toml`. And
`docs/operators/claim-policy-rollout.md` states outright that the two peerings the ramp existed for
were destroyed with the apex box (issue #872): _"there is nothing left to flip from `observe` to
`enforce` on either leg, and no live peering traffic on this fleet at all."_

### The reason that makes it more than housekeeping

**`Observe` is observable, so it cannot be excused as local policy.** A peer can tell: it receives
service without a covering claim. Under
[0047](0047-the-configuration-schema-is-implementation-detail-capabilities-are-law.md), an observable
fact is protocol law — so had this survived, the specification would have had to document the
protocol's own bypass. A protocol that ships a documented not-enforcing mode has specified how to
ignore it.

### What is given up, and why it is affordable

The canary step for a future peering bring-up, which `claim-policy-rollout.md` says it is still there
for. Smaller than it looks: **an enforce-mode refusal is already logged just as loudly** — the same
line, at the same level, by deliberate design (_"Refusing is logged rather than silent"_). An operator
bringing up a new peering can watch shortfalls today without admitting unpaid packets. What `Observe`
uniquely bought was not breaking **live** traffic while watching, and there is none to break until
somebody deliberately creates a peering — at which point re-adding a canary with a record explaining it
beats carrying one for years against a hypothetical.

`claim_enforcement` becomes a parsed-and-rejected key, the `ceiling` / `flush_interval_ms` /
`[peer_sale]` convention.

## Update — [ADR 0057](0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md) completes an amendment this record declined to make

This record amended [0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md) because banking
the claim made fee honesty bounded rather than self-enforcing, and left
[0010](0010-flat-per-packet-fee-and-minimum-delivery.md)'s minimum delivery listed as "unchanged".
**The same reasoning retires the floor**, and [0057](0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md)
applies it: once the claim is banked before the check, rejecting on a declared floor returns nobody
their value and only moves where the packet dies.

0057 is **blocked on item 3 above** and says so. Until a forwarded arrival must carry a covering
claim, the floor is the only bound on erosion on a forwarded path, and it stays.

Item 3 has since been built (issue #1142), which is what 0057 was waiting on — but note what the
observe default means for the sentence above: the mechanism that bounds erosion exists on every
peering, and **binds** only on a peering an operator has written
`forwarded_claim_enforcement = "enforce"` on. Retiring the floor is therefore no longer blocked on
code, only on the rollout that flips the peerings that carry traffic.

**0057 is now built too (issue #1143).** The floor is deleted — field, both carriage bindings, both
vectors and the `R01` reject. Item 3's own text above still spells the send-side figure as
`amount_after_fee(amount, fee, minimum_delivery)`; the signature is now
`amount_after_fee(amount, fee)`, and the figure it names — the amount this hop forwards, which is
what a peer must cover on arrival — is unchanged. Erosion is bounded by the covering claim alone,
and on a peering still defaulting to observe it is bounded by the send half's own coverage until an
operator flips it.
