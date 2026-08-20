# A reject code binds where a sender must act differently, and only there

**Status:** Accepted, **the table is stated here for the first time**. Extends [0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md), whose probe cannot work without it. Corrects three documents that claim nothing emits `T04`, alongside [0049](0049-the-cap-bounds-one-packet-is-discovered-by-t04-and-is-set-from-outside.md).

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**The reject codes are RFC 0027's; what this protocol adds is which code answers which situation.**
That mapping binds a second implementation **only where a sender can do something different on
receiving the specific code than it could knowing only the class.** Everywhere else, the class binds
and the code is the implementation's own.

## The test

> Can a sender take a different next action on this code than it could on its class alone?

If yes, the code is law. If no, binding it would freeze one implementation's internal taxonomy for no
interoperability gain.

This is not a stylistic split. [ADR 0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)
makes a probe the way cost is discovered — and a probe is a packet sent expecting a reject. A sender
that cannot tell _no route_ from _you did not pay enough_ from _you attached no claim at all_ learns
nothing actionable from one, and the probe stops working. Class-only was rejected on exactly that.

## The table

**Binding — the specific code is law.** Each names a distinct, actionable next move.

| code  | situation                                                                                                                                                                 | what a sender does about it                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `F00` | the app refused the envelope's target — it named something this handler does not expose                                                                                   | fix the target                                  |
| `F02` | no route matches the destination                                                                                                                                          | this path is wrong; find another                |
| `F03` | the amount exceeds the route's price, or the claim does not cover a priced termination ([0029](0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md)) | pay the stated amount                           |
| `F06` | no covering claim was attached at all                                                                                                                                     | attach one                                      |
| `F99` | a fulfilment does not satisfy the condition the sender minted                                                                                                             | **stop trusting that counterparty** — see below |
| `R01` | amount minus this hop's fee falls below the declared minimum delivery ([0010](0010-flat-per-packet-fee-and-minimum-delivery.md))                                          | lower the floor, or take a cheaper path         |
| `T04` | over this peering's cap ([0049](0049-the-cap-bounds-one-packet-is-discovered-by-t04-and-is-set-from-outside.md))                                                          | send smaller — and the message states the cap   |

**Class-only — `F`, `T` or `R` binds; the code does not.**

| code  | situation                                                                                                                                                                                           | why class is enough                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `F01` | undecodable envelope · zero or absent condition · malformed minimum-delivery header · a termination reject that could not be sealed                                                                 | the packet is malformed; there is one next move, and it is "fix the packet" |
| `R00` | the packet expired                                                                                                                                                                                  | relative by construction — the sender's own clock decided it                |
| `T00` | **this connector's own configuration error** — a destination matching both a live client session and a locally terminated route ([0032](0032-a-client-destination-is-never-a-route-termination.md)) | nothing about the packet is wrong; retry later                              |
| `T01` | the app or the next peer is unreachable                                                                                                                                                             | retry later                                                                 |
| `T05` | rate limited                                                                                                                                                                                        | retry later                                                                 |

`T00`'s choice is worth keeping even though it does not bind: an operator's misconfiguration is
reported as an **internal error**, never as a verdict on the packet — _"not a value judgement about
the packet"_. A second implementation should reach the same conclusion; it need not reach the same
code.

## `F99` binds against the test, deliberately

By the test above `F99` would be class-only: a sender cannot retry its way out of it. It binds anyway,
because **it is evidence about a counterparty rather than about a packet.** A fulfilment that does not
satisfy the condition the sender itself minted means the party that returned it is misbehaving or
lying — and a sender that can detect that should be able to, since the correct response is to stop
trusting a peer rather than to adjust a packet. Temporary-looking and permanent-meaning is exactly
when a specific code earns its place.

## What a reject carries besides its code

**The accumulated cost of the path it travelled** ([0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)) —
the sum only, never the per-hop breakdown and never the split between fees and price.

**`T04` states the current cap in its message** ([0049](0049-the-cap-bounds-one-packet-is-discovered-by-t04-and-is-set-from-outside.md)).
That is the whole discovery mechanism for a cap, and a bare `T04` would satisfy every other rule while
leaving a sender unable to size anything.

**Sealed or not, and what that proves.** A reject raised _at_ a termination is sealed back to the
sender; one raised short of it cannot be. The converse does not hold — a termination that never
recovered the shared secret also answers in plaintext ([0018](0018-a-payload-is-sealed-to-the-terminating-connector.md),
as amended). **Sealed identifies the destination; unsealed identifies nobody.**

## Consequences

**An app's `404` is not a reject.** It arrives as `Answered` and rides home on a **FULFILL**: the app
answered, and the answer is what was paid for. Only an app that is unreachable (`T01`) or that refuses
the envelope's target (`F00`) produces a reject. This is the sharpest thing in the table and it was
written down nowhere.

**Three documents still claim nothing emits `T04`** — `connector-domain/src/packet.rs`'s constructor
doc, [0033](0033-the-exposure-machinery-is-retired-not-restated.md)'s body, and
`peer-semantics-pre-868.md` §5.1–§5.3, which additionally omit the cap refusal. The last is frozen
history (issue #1065) and stays as it is; the other two are corrected.

**A second implementation may add codes this table does not list**, within the class its situation
demands. It may not reuse a binding code for a different situation.
