# Minimum delivery is retired: a claim bounds erosion, not a declared floor

**Status:** Accepted — **built** (issue #1143), on top of [0042](0042-a-packet-carries-its-claim.md) item 3 (issue #1142). **Retires** [0010](0010-flat-per-packet-fee-and-minimum-delivery.md)'s minimum-delivery half; 0010's flat-per-packet fee survives untouched. Amends [0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md), [0028](0028-a-forwarded-route-is-priced-at-the-client-edge.md), [0029](0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md), [0045](0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md) and [0051](0051-a-reject-code-binds-where-a-sender-must-act-differently.md). Completes the amendment [0042](0042-a-packet-carries-its-claim.md) made to [0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md) and declined to make here.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**A packet declares no minimum delivery. A hop carries a packet it was paid for and refuses one it
was not, and the claim covering each crossing is what bounds erosion — with money, rather than with
an advisory field every hop is trusted to honour.** The `minimumDelivery` field, its
`toon-minimum-delivery` and `Toon-Minimum-Delivery` carriage bindings, its role-dependent ignore
rule and the `R01` reject it produces are all deleted.

## The original argument was postpay reasoning, and it expired

[ADR 0010](0010-flat-per-packet-fee-and-minimum-delivery.md) justified the floor like this:

> _Without it, each hop silently reduces the amount and the sender learns what arrived only after
> the fact… Declaring the minimum inverts the failure: under-delivery becomes an explicit reject
> that the sender can act on._

That is sound **under [ADR 0004](0004-value-moves-on-fulfilment.md)**, where a hop that rejected
earned nothing. A hop had no incentive to erode, and the floor's job was to convert a silent
shortfall into a loud one at no cost to anybody.

[ADR 0042](0042-a-packet-carries-its-claim.md) inverted that premise, and said so — about the
clause next door:

> _ADR 0011 loses one inherited property. Its "understating a fee is unprofitable — honesty needs
> no enforcement" was reasoned from ADR 0004's postpay: a hop advertising a low fee and then
> rejecting earned nothing. **Under this record it banks the claim instead**, so fee honesty becomes
> bounded rather than self-enforcing._

**That reasoning applies verbatim to the floor, and ADR 0042 did not apply it.** Its Status line
records minimum delivery as "unchanged". Under ADR 0042 the covering claim is already banked by the
time a hop evaluates the floor, so rejecting on it does not return the sender's value. It changes
only _where_ the packet dies — at the eroding hop with `R01`, rather than at the termination with a
greeting. The loss is identical. A guarantee that does not change what anybody loses is not a
guarantee.

## What replaces it is already the mechanism

`Connector::cover_forward` mints a covering claim for **exactly the packet's own forwarded value**,
not for the crossing's fee. `local/two-hop`'s journal walk asserts the consequence: each accepted
claim "advances the cumulative amount by at least the price".

So every hop holds a claim for at least what it passes on, and its fee is the difference between
what it received and what it forwarded — which is [ADR 0010](0010-flat-per-packet-fee-and-minimum-delivery.md)'s
own earnings rule, unchanged. That property **chains**: if each hop is paid at least what it forwards
onward, then what reaches the destination is what the origin paid minus the sum of the fees, without
any hop being told a figure and trusted to check it.

The floor was a restatement, in an advisory field, of a property the claim amounts already carry and
enforce. Two mechanisms for one guarantee is the fault [ADR 0010](0010-flat-per-packet-fee-and-minimum-delivery.md)'s
own #1072 update named when it refused to give a client a floor _as well as_ a price: _"one guarantee
two mechanisms that can disagree."_ The same objection retires the peer half.

## The ordering is forced, and getting it wrong is unsafe

**This record must not be built before [ADR 0042](0042-a-packet-carries-its-claim.md) item 3.**
Today `connector_peer_btp::price_gate::payment_required` filters to `ClientRouteKind::Terminated`,
so a forwarded arrival is admitted with **no payment check at all**. "A hop carries a packet it was
paid for and refuses one it was not" is precisely the sentence that is not yet true of forwarding.
Until it is, the declared floor is the only thing bounding erosion on a forwarded path, and deleting
it first would leave a hop free to shave a packet to nothing with nothing to stop it.

What must be true for this record to be true, in order:

1. **[ADR 0042](0042-a-packet-carries-its-claim.md) item 3** — a covering claim is required on a
   forwarded arrival, behind that record's observe-then-enforce knob. Breaking; needs every box's
   send half live first.
2. **The refusal states its terms.** A hop refusing an under-covered forward answers with the
   greeting carried inside the reject, so the sender learns what it should have paid rather than
   only that it did not. This is the shape `price_gate` already uses at a terminated route, reused
   rather than reinvented.
3. **Then the field is deleted** — wire, carriage bindings, vectors, config and reject taxonomy
   together, in the sweep below.

## Rejected: keep it as a fail-fast belt

Keeping the floor purely for diagnostics — it dies at the eroding hop rather than at the destination
— was considered and rejected. It buys a better error message and costs a permanent field on the hot
path of every packet, propagated unchanged across two carriages, with its own malformed-versus-absent
rule, its own `F01` clause, its own role-dependent ignore rule and two committed vectors. The refusal
item 2 requires names the same fault at the same hop anyway.

## The sweep

Retiring a record means grepping for every record that cites it. Most citations survive; naming which
is what stops the next reader re-deriving this.

**Does not survive:**

- **[0010](0010-flat-per-packet-fee-and-minimum-delivery.md)** — the minimum-delivery half of its
  decision, its "Why minimum delivery rather than quoting" section, and the #1072 update's
  peer-versus-client asymmetry, which becomes moot when neither declares one. **Its flat-per-packet
  fee, its earnings rule and its cost-discoverability argument are untouched**, and are what the
  record is now for.
- **[0028](0028-a-forwarded-route-is-priced-at-the-client-edge.md)** — the clause "forwards
  `price - fee` … including its `R01` minimum-delivery rule". **The `F03` over-carry cap
  (`amount > price` on a priced forwarded route) survives and is unaffected**; so does everything
  about probes short-circuiting and rollback on reject.
- **[0029](0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md)** — `R01` in its
  list of refusals this wire already takes, and its "hop cannot forward at the declared minimum
  delivery" case in the reject taxonomy. Its own decision — a peer arrival at a priced termination
  covers that price — is what this record generalises to the forwarded case, and is strengthened,
  not disturbed.
- **[0051](0051-a-reject-code-binds-where-a-sender-must-act-differently.md)** — the `R01` row goes
  entirely, and `F01` loses its "malformed minimum-delivery header" clause. `R01` leaves the
  vocabulary: no sender action remains behind it, since "lower the floor" stops being a move a
  sender has.
- **[0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md)** — the
  `minimumDelivery` row of its carriage-binding table. **Its finding that peer semantics survive the
  transport is untouched** and is the reason the deletion has to land on both carriages at once.
- **[0045](0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md)** — the
  `minimum_delivery_absent` and `minimum_delivery_malformed` vectors are deleted. **This is a
  cross-repo wire change** (ADR 0021): `toon-client`, `rig` and `swap` replay these.

**Survives unchanged:**

- **[0036](0036-a-paid-deliverys-attribution-stays-on-the-connector.md)** cites 0010 only for when a
  fee is earned — already amended by 0042 and untouched here.
- **[0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)**'s probe economics and
  accumulated cost. A reject still states the cost of the path it travelled; that is how a sender
  discovers what to pay, and it becomes the _only_ such mechanism rather than one of two.
- **[0042](0042-a-packet-carries-its-claim.md)**'s cap. The cap bounds one packet against a hop that
  takes a claim and does not carry; the floor bounded erosion by a hop that does carry. Different
  failures, and only the second one is retired here.

## Consequences

**A sender's protection becomes uniform.** A client, a peer and an operator-originated packet are
protected by the same thing — the claim each crossing is covered by — rather than by a floor that a
peer declares, a client must ignore and the operator surface sets to a third value of its own
(`minimum_delivery = prepare.amount`, `connector-operator`, a convention no record ever carried).
That third convention disappears with the field rather than needing an answer of its own.

**A fee becomes chargeable on an operator-originated packet for the first time.** The
`minimum_delivery = prepare.amount` convention made `amount - fee >= minimum_delivery` unsatisfiable
for any non-zero fee, and that floor propagates unchanged across every hop. Every `fee` in every
`local/` topology is `0` as a direct result, so the flat per-packet fee — the connector's revenue
model — is exercised by `cargo test` alone and by no shipped image. Retiring the field is what makes
a priced multi-hop rehearsal possible.

**`R01` leaves the reject vocabulary**, and one reject code fewer is one fewer sender behaviour to
specify (ADR 0051's own test).

## Update (issue #1143, corrected) — `R01` does not leave the vocabulary; only its floor meaning does

**This record's sweep overreached on `R01`, and the error is this record's, not the
implementer's.** The sentence at fault, in the `0051` bullet and repeated as the closing
consequence:

> _`R01` leaves the vocabulary: no sender action remains behind it, since "lower the floor" stops
> being a move a sender has._

`R01` carried **two** meanings, and the sweep saw only one.

1. **The minimum-delivery meaning** — _amount minus this hop's fee falls below the declared floor_.
   This is [ADR 0010](0010-flat-per-packet-fee-and-minimum-delivery.md)'s, it is what ADR 0051's row
   described, and it does die here. "Lower the floor" genuinely stops being a move a sender has.
2. **RFC 0027's own meaning** — _Insufficient Source Amount: "the amount received by a connector in
   the path was too little to forward (zero or less)"_. This case is **untouched by this record**.
   `amount_after_fee` still returns `None` when the fee alone exceeds the amount, and a hop still
   has to answer something.

Meaning 2 was never this record's to retire. It does not come from ADR 0010; it comes from RFC 0027,
which [ADR 0051](0051-a-reject-code-binds-where-a-sender-must-act-differently.md) opens by making
the source of the codes: _"The reject codes are RFC 0027's; what this protocol adds is which code
answers which situation."_ Deleting a field this protocol invented cannot delete a code the base
protocol defines.

**So: `R01` is restored, narrowed to meaning 2 alone.** The `F03` rehoming issue #1143 made — a
reasonable call under this record's wrong premise — is reversed, and ADR 0051 carries the corrected
row. What the sweep should have said about `0051` is: _the `R01` row's **situation** is rewritten to
RFC 0027's, and its sender action with it; the row itself stays._ `F01`'s loss of its
"malformed minimum-delivery header" clause was correct and stands.

### Why `F03` was the wrong home, on this protocol's own test

ADR 0051's test is whether a sender can act differently on the code than on its class alone. Two
things separate the cases:

- **The class letter is itself an instruction.** RFC 0027 makes `F` final and `R` relative —
  _"Relative errors indicate that the payment did not have enough of a margin in terms of money or
  time"_, and a sender **MAY retry with a larger margin**. Answering `F03` tells a sender its packet
  is finally invalid when the truth is "send more". That is not a nuance of taxonomy; it is the
  opposite retry decision.
- **The situations differ.** `F03`'s row is an amount wrong against a **price** — the route's, or a
  priced termination's — where the sender's move is to pay the stated figure. Here there is no price
  in question: the hop's own fee consumed everything and nothing would go onward. ADR 0051's closing
  rule is that an implementation _"may not reuse a binding code for a different situation"_, and
  folding this into `F03` is that reuse, committed by this record's own author.

The cross-repo argument agrees rather than leads: ADR 0051 is scoped **protocol law**, `toon-client`,
`rig` and `swap` read it, and a standard ILPv4 code answering the standard ILPv4 situation is what
those readers can already handle without being told.

### What did not change

**Everything else in the sweep stands**, including every deletion issue #1143 made: the field, both
carriage bindings, the two vectors, the role-dependent ignore rule, the `F01` clause, and
`connector-operator`'s `minimum_delivery = prepare.amount` convention. This record's decision —
_a claim bounds erosion, not a declared floor_ — is unaffected, because a hop that cannot cover its
own fee forwards nothing and therefore mints no covering claim either. The correction is to which
code names that, and to the reasoning this record gave for erasing it.

**No vector moves and `schema_version` stays at 3.** The reject vocabulary is prose in ADR 0051, not
a pinned frame (ADR 0045), so `vectors/wire-vectors.json` is byte-identical across this correction.
An SDK written against schema 3 as first published would expect `F03` here and now gets `R01`; that
is a behavioural change announced in prose, which is exactly the gap ADR 0045 names and exactly why
the code's own emission site, its message, ADR 0051's table and this Update are landed together.
