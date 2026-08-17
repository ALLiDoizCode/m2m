# Purchasable peering is removed

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

**A peering cannot be bought.** It is created by the operator — in the config file, or through the
operator surface — and by nothing else. The `[peer_sale]` section, `Connector::deliver_peer_sale`,
the peer-sale route kind, the purchase lease and the purchase abuse bounds are all deleted rather
than gated behind an approval step.

## What this removes

- **[ADR 0037](0037-a-purchased-peering-is-a-terminated-route-whose-work-is-a-table-write.md)** in
  full: `[peer_sale]`, the priced write, `deliver_peer_sale`, the purchase terms
  `{ prefix, fee, price, next_hop_price }`, `covers_next_hop` and `config_owns_ancestor_of`.
- **[ADR 0038](0038-a-peer-sale-lease-demotes-at-match-time-and-reaps-off-the-hot-path.md)** in full:
  the lease, its match-time demotion and its off-hot-path reaping. It solved expiry for a row shape
  that no longer exists.
- **[ADR 0039](0039-abuse-bounds-on-a-purchased-peering-refuse-not-refund.md)** in full:
  `max_purchased_rows`, `max_routes_per_payer`, `max_prefix_length` and the purchase rate limiter.
  These bounded a network-writable primitive; with nothing network-writable left, they bound nothing.
  **"Refuse, not refund" survives as a principle** — this repo still has no refund path and still
  wants none.

Removed config keys become parsed-and-rejected traps, the convention `peer_wire_addr` and `ceiling`
already established: an operator whose committed TOML still names `[peer_sale]` gets a named error
at boot rather than a silent `deny_unknown_fields` drop.

## What survives

**[ADR 0034](0034-a-runtime-peer-route-table-never-shadows-the-config-file.md)'s runtime peer/route
table is untouched.** Being mutable at runtime and durable across restarts is a property the
_operator_ needs; it was never about selling. Config rows still own their address space and a
runtime row still cannot shadow them.

**[ADR 0006](0006-the-connector-is-mechanism-not-policy.md) is restored without qualification.** Its
rule — "it does not decide who its peers are" — had one exception, and that exception was payment.
There is now no path by which a stranger becomes a peer. ADR 0006's own forward reference to a
"sold peering (#867)" needing a third row shape lapses with the feature.

## Why removal rather than approval

An approval queue was the alternative, and it was drafted. It preserved the revenue and put the
operator back in the decision, but it bought that with a second network-writable table to bound, a
FULFILL whose meaning changed from "you have a peering" to "your request is recorded", a new status
surface for a buyer to learn its outcome, and a non-refundable payment for a thing the operator may
simply bin. That is a large amount of machinery and explanation for a feature the fleet does not yet
need, and every piece of it is a premise some later record would reason from — which is the failure
mode this ADR series has just spent several records unwinding.

Deleting is reversible: the decision is recorded here, the reasoning in ADR 0037 survives at its own
number, and reinstating it later is a new record rather than an archaeology exercise.

## Consequences

**[ADR 0042](0042-a-packet-carries-its-claim.md)'s per-peer cap is unaffected.** Its justification
already rests on ADR 0042's law 03 — packet size is the dial trust turns for every peer — and not on
guarding against self-admitted ones. That reasoning was corrected before this record existed.

**Price discovery loses an advertisement channel.** ADR 0037 advertised a purchasable peering in
kind:10032. Nothing replaces that, and nothing needs to: a connector answers when asked
([ADR 0022](0022-a-connector-answers-it-does-not-announce.md)), and
[ADR 0044](0044-a-probe-answers-what-a-route-costs-and-what-it-does.md) is where a caller learns what
a route costs and what it does.
