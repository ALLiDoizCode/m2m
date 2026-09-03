# A deadline bounds the wait for an app, not the answer it gives

**Status:** Accepted — **built** (#1183). Extends [0019](0019-a-terminating-connector-derives-the-fulfilment.md) with the one condition under which a termination declines to derive a fulfilment, and completes at the last hop what `packet-flow-spec.md` PF-19 (#1180) did at every hop before it. Amends [0020](0020-a-price-is-flat-and-attaches-to-a-handler.md): "value moves whenever the app answered" gains "and answered in time".

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**A packet's expiry bounds how long a terminating connector waits for its app,
and nothing else.** When the deadline fires first the request is abandoned and
the packet is refused `R00`; a packet with nothing left when delivery is reached
is never handed to the app at all. But an answer the app produced inside that
budget is answered for, however close to the line it came — there is no second
expiry check applied to work already done, and no verdict at a termination is
ever chosen in order to decide who pays.

## Context

`packet-flow-spec.md` PF-02 checked a packet's expiry once, on arrival, and
nothing re-checked it afterwards. The app-delivery path
(`Connector::deliver_to_app` → `deliver_opened_envelope`) never read
`expires_at` at all. So an app that took an hour over a thirty-second packet was
still answered for: this connector derived the fulfilment
([0019](0019-a-terminating-connector-derives-the-fulfilment.md)) and returned a
FULFILL to an upstream that had given up and — if it was another connector —
moved on.

That is the termination-side twin of the forwarding race #1180 closed one
release earlier. PF-19 made a hop keep a message window back when it forwards,
and refuse `R00` when nothing is left, precisely so a fulfilment answered in
time downstream can still reach upstream in time. PF-19 is scoped to forwarding,
so it stopped at the last hop, which is where the packet actually spends its
time.

Issue #1183 set out three shapes — check before delivery, check after it, or
bound the app call itself — and named the second as the awkward one: the app has
already done the work, so rejecting means it served a request nobody paid it
for, while fulfilling means the payer is charged for an answer nobody can use.

**That dilemma is false, and the reason is worth stating plainly, because the
intuition behind it is the retired half of [ADR 0004](0004-value-moves-on-fulfilment.md).**

- **The claim was taken before the app was called.** On the client edge
  `ClientClaimGate::ingest` verifies the covering claim, advances the channel's
  watermark and journals it _before_ routing begins; on a peer arrival
  `ClaimBook` does the same, and a peer's claim verdict never gated its packet
  anyway. Only one path gives a claim back — `roll_back_uncarried_forward`
  (#1012) — and it is deliberately scoped to a **forwarded** route whose next
  hop terminally rejected, because that is the one case where the packet was
  never carried at all. A termination's reject rolls back nothing.
- **So the verdict decides nothing about who is out of pocket.** Rejecting a
  late-but-real answer refunds nobody. It destroys work the payer has already
  been charged for and hands them a reject instead of the answer they bought:
  the worst of both, not a compromise between them.
- **And it would be a false statement besides.** Under
  [0042](0042-a-packet-carries-its-claim.md) a fulfilment "proves that the
  intended receiver got the packet and nothing else — it is a delivery receipt,
  not a payment trigger". The intended receiver did get the packet. A connector
  suppressing that receipt would be lying about a delivery it made, and would be
  the only place in this protocol that does.

The "reject it so the payer is not charged" instinct is coherent only under ADR
0004's model, where the fulfilment is what moves value. ADR 0042 retired that
model. What is left is a receipt, and a receipt for a delivery that happened is
true.

## Decision

**The deadline bounds the wait, not the answer.** Three clauses, and the third
is the one that carries the argument.

**1. A packet with nothing left is not delivered.** When the expiry has already
fired by the time delivery is reached, the app is not asked. `R00`, and the
reject carries `accumulated_cost = 0`: the app did no priced work, the same
figure and the same reason as an unreachable app or a refused envelope target.

**2. The app call is bounded by the packet's own deadline.** Not by a
configuration value — by the expiry the sender already put in the packet. When
it fires first the request is abandoned rather than waited on: the connector
stops waiting and answers `R00`, with `accumulated_cost` set to the route's
price, because the packet reached its termination and the priced work was set in
motion (#545). A sender learns "your answer was too slow", not "this path is
free".

**3. An answer produced inside the budget is honoured, unconditionally.** No
expiry check is applied to work already done. An app answering one millisecond
inside the deadline fulfils exactly as a prompt one does, and this connector
never re-reads the clock after the app has spoken. Deciding otherwise would make
the verdict depend on this connector's own serialisation and sealing cost, which
is neither the sender's business nor stable between two runs of the same
software.

**A termination keeps no message window back, where a forward keeps one.** That
asymmetry is what PF-19 bought. The hop above already shortened this packet by
its own window before handing it here, precisely so the answer has time to
travel home; a termination shortening _again_ would spend a second window on a
return leg somebody else has already paid for, and refuse packets it could have
served. Where nobody shortened — a packet a client posted straight to this
connector's edge — the deadline is the payer's own, unmediated, and spending all
of it is doing exactly what the payer asked.

**The client-sent and forwarded cases get the same rule**, and the difference
between them is a reason to keep it that way rather than to split it. For a
packet a client posted to `POST /ilp`, the upstream _is_ the paying client and
the deadline is its own. For a forwarded packet the upstream is another
connector, and the deadline this hop holds has already been shortened by every
hop above — so the rule is _stricter_ in the forwarded case, automatically, with
no second code path. Splitting them would buy nothing: neither case waits past
the deadline, and in neither does the verdict move money. Two rules on the
hottest path in the binary, to distinguish two cases that behave identically, is
how the taxonomy in ADR 0051 gets diluted.

**Both refusals are sealed.** They are raised below the gift wrap, with the
sender's shared secret already in hand, so they ride home sealed like every
other verdict a termination reaches
([0018](0018-a-payload-is-sealed-to-the-terminating-connector.md), PF-24).
Checking before the wrap was open would be marginally cheaper and would leak an
unsealed reject for a packet this connector can read perfectly well.

**`R00` in both cases**, the code PF-02 gives an already-dead arrival and PF-19 a
forward with no window left. The fact is the same in all three: the packet ran
out of time, and the sender's move is a fresh packet with more budget rather
than anything about this path. `R00` is class-only under
[0051](0051-a-reject-code-binds-where-a-sender-must-act-differently.md) — there
is no distinct action to bind, so the message carries the diagnosis. `T01` is
the available lie: the app was reachable, it was simply slower than the sender
allowed, and `T01` would send a sender hunting for another path.

## Considered options

**Check after delivery and reject a late answer.** The shape #1183 called the
real race. Rejected on the argument above: it refunds nobody, destroys a
paid-for answer, and contradicts ADR 0042's reading of what a fulfilment
asserts. Its appeal rests entirely on ADR 0004's retired model.

**Check only before delivery.** Cheap and obviously right, and it is clause 1 —
but on its own it is nearly a no-op, because the arrival check and the delivery
are microseconds apart in the same task. It closes the case of a packet that
arrives late, which PF-02 already had, and leaves untouched the case that
matters: an app that is slow.

**Refund the claim instead of rejecting.** Extend `roll_back_uncarried_forward`
to terminations, so a late answer can be rejected _and_ the payer made whole.
Rejected, and worth recording why: the rollback exists for a packet that was
**never carried**, which is a fact about this connector's own conduct. A
delivered packet was carried and served. Rolling back there would mean an app
can be driven to do unlimited work for free by any sender willing to specify a
tight deadline — precisely the attack ADR 0020 refused when it declined to make
app errors free.

**Give a termination a message window of its own**, symmetric with PF-19.
Rejected: double-counting. The window PF-19 keeps is per crossing, and the
crossing above this termination is already covered by the hop that made it.

**Make the app timeout a configuration value.** Rejected as a first move,
though not forbidden later. A `handler_url` timeout is a property of an
operator's own app and could only ever be _shorter_ than the packet's deadline —
whichever fires first wins, and this record fixes the ceiling. Making the
ceiling itself configurable would let an operator sell a service it structurally
cannot deliver in time, which is the thing this record exists to stop.

## Consequences

**An app that is reliably slower than its senders' deadlines now fails
visibly**, as `R00`s rather than as fulfilments nobody upstream could use. That
is a real behaviour change for a deployment whose handler is slow and whose
clients are patient; the operator's answer is the same as ADR 0020's for a
broken app — watch your own latency — with the difference that the failure is
now legible to the sender.

**The app may finish work that is no longer waited on.** Dropping the request
future closes the socket to the handler, but a handler already executing will
usually run to completion. Whether it is compensated is an operator-internal
question: the app and its terminating connector are one trust domain
([0019](0019-a-terminating-connector-derives-the-fulfilment.md)), and no
protocol fact distinguishes them. That is why "the app served a request nobody
paid it for" is not a dilemma this record has to resolve.

**A sender can now cause work it does not pay for**, by naming a deadline too
tight for the handler. It is bounded by the claim it must still present to get
in at all — the request is charged whether or not the answer comes back — so
this is a way to waste money, not to spend none.

**One timer now exists on the packet path.** The _decision_ is
`connector_domain::delivery_budget`, pure arithmetic over the injected clock and
property-tested there ([0007](0007-testing-doctrine-fakes-yes-mocks-no.md)); the
_mechanism_ that stops waiting is a real `tokio` timer, because when to stop
waiting is not something a clock port can be asked. `connector-runtime` gains
tokio's `time` feature for it and nothing else.

**No wire surface changes.** No field, no encoding, no new reject code — `R00`
is already emitted at two other points on this path. `vectors/wire-vectors.json`
is untouched, and this record enters
[0045](0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md)'s
debt ledger as PF-25, alongside the rest of `packet-flow-spec.md`.
