# A peer PREPARE arrives with its covering claim, or it is greeted

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**Owner decision, 2026-08-07 (issue #868):** a peer-role PREPARE may not arrive without a covering
claim. Every packet is paid, or it gets the x402 greeting — the same rule the client edge already
enforces. **The credit window is retired** as the peer path's operating mode.

This applies to **both** ends of the peer path: a connector refuses a claimless peer PREPARE it
receives, and covers every peer PREPARE it sends. It is not a receive-side gate bolted onto an
otherwise unchanged forward path.

## Context

### What the peer path did before this decision

Verified against `275ff378` on 2026-08-07 — read, not assumed, because these lines drift.

**Receive: a claimless PREPARE was admitted.** `Connector::handle_peer_prepare` takes
`claim: Option<WireClaim>` and treats `None` as an ordinary outcome rather than a refusal —
`claim.map_or(ClaimAckOutcome::NotSent, …)`, after which the packet proceeds to the exposure-ceiling
check and the price check (`crates/connector-runtime/src/connector.rs:667-676`, ceiling at
`:678-689`, ADR 0029's `F03` price gate at `:691-705`). Nothing between the wire and the app asks
whether a claim was present.

**There was no knob to turn it on.** `require_claim`, `claim_required` and `requires_claim` do not
appear anywhere in `crates/` — an exhaustive grep over the whole crate tree returns nothing. Claim
coverage on the peer path was not a policy an operator had configured loosely; it was not
expressible.

**`ceiling = 0` did not approximate this rule, and could not.** A peering's `ceiling` is
`Option<u64>` (`crates/connector-config/src/peer.rs:380`, accessor at `:454`), and an absent one is
**unbounded**, not zero: `build` calls `with_channel_ceiling` only when the peering configures a
figure (`crates/connector-cli/src/runtime.rs:654-661`), and a channel with no ceiling registered is
never over one (`crates/connector-runtime/src/claim.rs:828-837`, `None => false`). Even a
configured `0` does not close the gap, because the predicate is strict: `is_over_ceiling` is
`exposure > ceiling` (`crates/connector-domain/src/projection.rs:172-174`), and exposure is still
`0` when the check runs — so `ceiling = 0` admits one uncovered packet before `T04` ever fires.

**Send: the forward path emitted claimless PREPAREs by construction.** `forward_via_peer_route`
attaches whatever `ClaimBook::pending_claim` currently holds
(`crates/connector-runtime/src/connector.rs:996`), and `pending_claim` reads a slot that is armed
only by `record_fulfillment` after a fulfil (`connector.rs:1009-1010`) and cleared by
`acknowledge_outbound` as soon as the far side acks (`claim.rs:1024-1033`, documented at
`claim.rs:966-975`: it "answers `None` once the most recent claim has been acknowledged"). Between
an ack and the next fulfilment there is nothing to attach, so the connector sends a bare PREPARE —
not through misconfiguration, but as the designed steady state.

**The client edge already enforces the rule this ADR extends.** Pay-to-write is absolute for a
priced route there: "there is no configuration, flag or build profile that disables any of §1.3's
checks" (`crates/connector-client-edge/src/lib.rs:26-30`). An unpaid request to a priced route it
terminates is answered with that route's terms — the x402 greeting — instead of being routed at
all.

### Why the credit window existed

[ADR 0004](0004-value-moves-on-fulfilment.md) established that value is owed on fulfilment, so a
claim can only follow the fulfilment that created the obligation: "the claim covering it follows the
fulfilment rather than riding the outgoing PREPARE." `peer-wire-spec.md` §3.2 is the mechanism that
falls out of it — the claim rides the **next** frame to that peer, and the flush timer (§3.3) bounds
how long the last packet of a burst stays uncovered. `T04`'s ceiling (§5.3) bounds how much
uncovered value accumulates in the meantime. That window — trailing exposure, bounded by a timer and
a ceiling — is the credit window this decision retires.

**That rationale is superseded, not wrong.** It was correct for the world it was written in: a
forwarding connector had no way to sign a claim for a packet it had not yet been paid for, so
"pay after the fulfil" was the only coherent answer available, and ADR 0004's argument against
prepay — that it makes the execution condition economically inert — remains sound and is not
disturbed here. What changes is not that argument but the option set: with a runtime-side outbound
client ledger (issue #866) a hop can cover the packet it is about to send, which was not on the
table when ADR 0004 was written. Nothing in ADR 0004's reasoning is retracted, and none of it is
deleted.

## Decision

**A peer-role PREPARE that arrives with no covering claim is refused, with the same greeting the
client edge gives an unpaid request. A connector covers every peer PREPARE it sends.** One rule,
both edges: the client edge and the peer path now answer the same question the same way, and the
answer is not configurable on either.

Two things follow directly, and are part of the decision rather than downstream of it:

- **The credit window is gone as an operating mode.** Value and its covering claim travel together.
  There is no interval during which a peering has forwarded value it holds no signature for as a
  matter of normal flow.
- **Peer role rests on P2 alone.** See "Identity" below.

## What this inverts

**[ADR 0004](0004-value-moves-on-fulfilment.md), for the peer path.** Its sentence "the claim
covering it follows the fulfilment rather than riding the outgoing PREPARE" stops being true of a
peer PREPARE. ADR 0004 stands unchanged for everything else it decides — value moves on fulfilment,
one claim per packet, no batching, `lockedAmount`/`locksRoot` stay dead — and its own account of why
the credit window was right remains in place, marked superseded where this ADR supersedes it. ADR
0004 carries a pointer to this ADR saying so.

**`peer-carriage-spec.md` §3.1's "a connector MUST NOT answer a peer-role PREPARE with the x402
greeting."** That rule rests on the sentence beside it — "PREPAREs never carry claims to gate at
PREPARE time" — which this decision makes false. A claimless peer PREPARE is now greeted, exactly as
the client edge greets an unpaid client request. The rule survives for what it was really about:
[ADR 0029](0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md)'s
`F03_INVALID_AMOUNT` — a peer that carried a claim but too small an `amount` for a priced
termination — is still a plain reject, not a negotiation. Peer **fees** remain bilateral
configuration, not something a greeting quotes.

**`peer-carriage-spec.md` §1.5's "role is decided before it decodes a claim."** That ordering exists
precisely because claimless peer packets exist; it falls with them. The spec edits themselves are
issue #868's, not this ADR's.

## Consequences

**Identity: the `{peerId, secret}` bearer credential has no job left.** A claim is verified against
the counterparty this connector itself recorded for the channel the claim names, never against
anything the claim declares about itself — `ClaimBook::verify_signature` recovers the EVM signer and
compares it to `counterparties[channel_id]`, and checks an ed25519 signature against the registered
`SolanaChannel`'s `counterparty_public_key`, answering `UnknownChannel` when either lookup misses
(`crates/connector-runtime/src/claim.rs:1055-1089`, field docs at `:439-453`). With a claim on
**every** packet, the sender's identity is proven cryptographically on every packet — strictly
stronger than a shared secret, which proves only that whoever holds it holds it. **Peer role
therefore rests on P2 — the `[[peer_channels]]` binding — alone.** P1, the proven credential, has
nothing left to establish that the claim does not establish better. This settles the open question
issue #863 was filed about and vindicates issue #867's premise.

**Issue #866 is a MANDATORY dependency, not an optimisation.** The forward path today cannot sign a
claim for the packet it is about to send: `pending_claim` returns a watermark armed by a _prior_
fulfilment (`claim.rs:958-964`) and there is no other outbound signing path on that code route.
Covering every forwarded packet requires exactly the runtime-side outbound client ledger #866
describes. Landing the receive-side refusal without #866 would leave a fleet whose connectors refuse
each other's traffic, so the two ship in dependency order.

**Every peering is now a two-sided change.** A live peering whose counterparty still sends claimless
packets stops being served the moment the receive side lands. What happens to such a peering during
rollout — migration and sequencing — is issue #868's to state; it is not left to whoever notices
first.

**Resolved by issue #883** (child B6): senders (the B3 covering behaviour) roll to every box before
receivers (the B2 refusal behaviour) roll to any — a receiver that refuses before its counterparties
can cover is a hard outage, and the safe order is stated and justified, not assumed. A temporary
per-peering `claim_enforcement` config knob (`connector-config::peer::ClaimEnforcement`, default
`Enforce`) lets a receiver `Observe` — admit and log an uncovered PREPARE rather than refuse it — as
a canary step before a box is flipped to enforce; it is dated for removal once the fleet-wide
rollout is confirmed. The three-box fleet runbook, its config dry-run recipe and its positive-evidence
checks are `docs/operators/claim-policy-rollout.md`.

**The exposure machinery's remaining purpose is undecided here.** `record_inbound_delivery`
(`claim.rs:844`), `ceiling` and `flush_interval_ms` either go away or become a residual safety bound
with a restated purpose. Issue #868 owns that call. What this ADR fixes is that the question is now
asked out loud rather than left as the undocumented state issue #863 was filed about.

**Resolved by [ADR 0033](0033-the-exposure-machinery-is-retired-not-restated.md)** (issue #882,
child B5): removed, not restated. The measured throughput cost of keeping it (a third `fdatasync`
per packet) settled what this paragraph left open.

**The throughput question is open and must be measured before rollout reaches the huddles
workload.** Issue #710 records up to three fsyncs per forwarded packet in the peer claim journal,
and the mesh-compute prototype found a single fsync accounting for 99% of p99. Reading the doc
comments, `record_inbound_delivery` journals durably too, so both paths appear to hit disk and the
window may have been saving nothing — but that is unverified, and "appears to" is not a measurement.
This does not gate the decision; it gates how fast it rolls.

**Resolved by issue #1033**, for the covered _forward_ (send) side — issue #879/ADR 0033's table
above is the covered _receive_ side; neither issue had measured the other. `cover_forward` (#881)
was untested outside a unit test before #1033: an exhaustive grep at the time found exactly two
callers of `with_outbound_client_hop`, `connector.rs`'s own tests and the new bench. Measured with
`crates/connector-runtime/examples/covered_forward_bench.rs` — a real `Connector`, a real HTTP
watermark round trip over loopback TCP, a real `OutboundClientLedger` file and `fsync`, nothing
stubbed — same method as the table above: kernel-counted syncs via an `LD_PRELOAD` shim
interposing `fsync`/`fdatasync` (`strace` is unavailable in this sandbox; the shim counts the same
two libc calls `strace -e trace=fsync,fdatasync` would, without ptrace overhead), 500 packets for
the sync count and 2940 packets at 49/s (60 seconds of a huddle) for latency, each reproduced
across two runs:

| path                                         | syncs/pkt      | watermark RTT      | p50 @ 49fps | p99 @ 49fps |
| -------------------------------------------- | -------------- | ------------------ | ----------- | ----------- |
| uncovered (pre-#881 postpay, ADR 0004)       | 1.00 fdatasync | none               | 0.74 ms     | 1.32 ms     |
| covered, persistent connection               | 1.00 fsync     | yes                | 1.03 ms     | 1.71 ms     |
| covered, in-memory ledger (isolates the RTT) | 0.00           | yes                | 0.61 ms     | 0.75 ms     |
| covered, fresh connection per call           | 1.00 fsync     | yes, no keep-alive | 1.17 ms     | 1.92 ms     |

The watermark round trip's own contribution, timed directly around the call rather than inferred
by subtraction (a thin wrapper around the real `HttpClaimState`, timing nothing else):

| connection reuse            | p50    | p99    |
| --------------------------- | ------ | ------ |
| persistent (one client/hop) | 278 us | 384 us |
| fresh client, every call    | 407 us | 554 us |

**Verdict: the covered forward's send-side cost is viable at 49fps as it stands.** It does not add
a fourth durable write on top of #879's number — `connector.rs`'s own doc comment claimed that and
was wrong twice over: #879's 3.00 was the pre-ADR-0033 figure (the current receive-side cost is
2.00), and the covered send side's own write is one `fsync` on a different ledger, the same order
as the peer ledger's own per-forward write it replaces on the send side, not an addition on top of
it. The only genuinely new cost is the watermark round trip, and at 278us p50 / 384us p99 against a
~20.4ms inter-packet budget at 49fps it consumes under 2% of it; every run held the requested 49.0/s
achieved rate. A persistent connection cuts the round trip's own p50 and p99 by roughly a third
versus opening a fresh one per call (278 us against 407 us at p50, 384 us against 554 us at p99),
answering the "what does a persistent session change" question directly: reuse is worth having, and
a hop should hold one client — but the ~170 us it saves at p99 is an order of magnitude below the
~1.8 ms a single extra `fdatasync` cost at p99 in ADR 0033's own numbers, so it is a tuning choice,
not a rollout gate.

**What this verdict does not cover.** This is a local, single-hop, loopback measurement of latency
and durable-write cost; it says nothing about WAN round-trip variance to a real receiver, and
nothing about #1031's actual concern — locked capital per in-flight packet under the hold #1031
proposes. A small, cheap watermark round trip does not make a capital lock cheap; that is a
separate question #1032 and #1034 own. This issue answers only the one ADR 0031 deferred: whether
the covered path's own throughput cost, as it ships today, is a rollout blocker. It is not.
