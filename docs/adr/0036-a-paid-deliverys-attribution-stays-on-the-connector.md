# A paid delivery's attribution stays on the connector, never on the app

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

A terminating connector tells the app nothing about the payment that brought a packet to it — not
who paid, not how much, not on what chain. There is no successor to the relay's retired
`X-TOON-Payer` / `X-TOON-Amount` / `X-TOON-Chain` headers, and there should not be one: `amount` is
implied by which handler fired (ADR 0020), `chain` is dropped with no successor because it never
had an honest one, and `payer` is retained by the connector and is never handed to the app. What
the connector already records about a paid delivery — a per-packet structured log, a durable claim
journal, and its metrics — is the honest successor, once its one real gap (nothing joins the
per-packet record to the per-channel money record) is closed.

## Context

### The relay's record, and why its inputs are gone

`relay/packages/relay/src/launcher/handlers/write-handler.ts` reads `X-TOON-Payer`,
`X-TOON-Amount` and `X-TOON-Chain` off an inbound request, logs
`[write] event=… payer=… amount=… chain=…`, and echoes all three back in the response body. Its
own comment says it "trusts the injected `X-TOON-Payer`/`-Amount`/`-Chain` headers WITHOUT
re-validating payment" — the record's honesty was never better than the headers a hop chose to
inject.

Issue #505, which would have had the Rust connector inject an equivalent header, is closed as
superseded. [ADR 0017](0017-the-typescript-connector-is-a-prototype.md) gives the reason none of
the three can simply be reproduced: `X-TOON-Payer` carried the immediate previous hop rather than
the payer, so _"on any path longer than one hop the header names the wrong party, and the relay's
per-write attribution record is wrong with it. It looked correct only because the deployed path was
one hop."_ `X-TOON-Chain` fares no better — derived from the second label of the destination
address, i.e. chosen by whoever addressed the packet, and presented to the app as if the connector
had asserted it.

`git grep -in "X-TOON" -- crates` on this repo returns nothing, and issue #535's first comment
confirms the consequence is live: a real, paid write through the Rust fleet reaches the devnet relay
and every attribution field on its own record comes back empty
(`[write] event=… payer=- amount=- chain=-`). The relay does still know the write arrived on a
paid, terminated route — an unpaid request is answered with x402 terms and never reaches it, and
under [ADR 0020](0020-a-price-is-flat-and-attaches-to-a-handler.md) whatever arrives at one of its
handlers was paid at that handler's one price. What is genuinely lost is _who_.

### Field by field

**`amount`.** Answered by ADR 0020 rather than by a header: one handler, one price. The relay's own
route configuration already states the price of the handler that fired, so it does not need to be
told a second time by the packet that reached it. On the connector side the aggregate is
`toon_fees_earned_total` ([ADR 0014](0014-metrics-surface-and-packet-correlated-logs.md)), earned
on fulfilment per [ADR 0010](0010-flat-per-packet-fee-and-minimum-delivery.md).

**`chain`.** No honest source, and never had one. ADR 0017 shows it was derived from the
destination's second label — payer-influencable — and presented to the app as connector-asserted.
It is a settlement-layer fact an app has no use for. **Dropped with no successor.**

**`payer`.** Honestly assertable, but only by the connector, and only as _"the client channel the
covering claim was accepted on."_ The connector holds that mapping in `ClientChannelRegistry`
(`crates/connector-client-edge/src/channels.rs`), populated either from `[[client_channels]]` or
resolved from chain, and it is authoritative: client-edge-spec.md §1.3 step 4 reads the accepted
signer from that record, and _"nothing falls back to the claim's own self-declared signer."_
Handing this to the app would mean re-introducing a trusted header — the exact mistake ADR 0017
documents. **Payer attribution stays on the connector.**

### What the connector already records, and why it is more than the headers ever were

- **Per-packet structured logs.** [ADR 0014](0014-metrics-surface-and-packet-correlated-logs.md):
  every log line emitted while a packet is handled sits in a `"packet"` tracing span carrying
  `correlation_id` — the packet's own execution condition, hex-encoded, invariant across hops — and
  `destination`. One JSON object per line, joinable across a hop boundary with no wire change.
- **The money record.** `JournalEntry::InboundClaimAccepted` / `OutboundClaimSigned`
  (`crates/connector-domain/src/projection.rs`) in a durable `FileJournal` under `state_dir`,
  projected to `ClaimView` (`crates/connector-runtime/src/operator_view.rs`) and read at
  `GET /claims`; channel counterparty, deposit and redeemed amount at `GET /channels`.
  [ADR 0005](0005-claims-are-truth-balances-are-a-projection.md): claims are truth, balances are a
  projection.
- **Metrics.** `toon_packets_total{outcome}`, `toon_packets_rejected_total{code}`,
  `toon_fees_earned_total`.

### The one real gap

The money record is per channel and cumulative (`ClaimView` is nonce + `cumulative_amount` per
direction per channel); the packet record is per packet (`correlation_id`). **Nothing joins the
two**, so an operator holding both halves still could not answer "which payer paid for this
specific delivery" before this decision. That join — not a header — is the honest successor to the
relay's record.

## Decision

**No new header, no new wire field, nothing new is told to the app.** `git grep -in "X-TOON" --
crates` continues to return nothing.

**The gap is closed on the connector side, not the relay's.** The terminating connector's
`"packet"` span (ADR 0014) now also carries `client_channel_id` — the client channel whose covering
claim admitted the packet — whenever a claim was presented. A packet with no claim (an unpriced or
unclaimed request, or a peer-wire arrival) is unchanged: the field is simply absent, not recorded
empty. The value is the chain-namespaced channel key the claim itself is judged under
(`evm:<channel id>` or `solana:<channel account>`), so a claim on either chain names its channel
unambiguously. That channel's `counterparty` at `GET /channels` is exactly "which payer paid for
this delivery" — assembled from records the connector already kept, at the cost of one more field
on a log line that already existed.

This is implemented in `crates/connector-runtime/src/connector.rs`
(`Connector::handle_prepare_with_client_channel`), threaded from the client edge's claim admission
(`crates/connector-client-edge/src/lib.rs`'s `handle_ilp`, and `btp.rs`'s `finish_frame`) through
`session_route::route_prepare`. Asserted by
`connector::tests::packet_span_carries_the_admitting_client_channel_id_when_a_claim_admitted_the_packet`
and its sibling `..._omits_client_channel_id_when_no_claim_admitted_the_packet`, both of which
capture the span's actual recorded fields rather than inspecting the call site.

**The relay-side consequence is filed as a cross-repo issue, not written here.** It is: the relay
stops reading and echoing `payer`/`amount`/`chain`, and logs what it can honestly assert — the
event id and which handler fired — with the price coming from its own route table under ADR 0020.
`relay/packages/bls/src/pricing/config.ts` loses its consumer in the same change, so the two
removals travel together. See [toon-protocol/relay#122](https://github.com/toon-protocol/relay/issues/122)
(filed alongside this ADR).

## Considered options

**Reintroduce a payer header, scoped to first-hop-only deployments.** Rejected: ADR 0017 already
names this as the exact failure mode — it is correct only as long as the deployed path stays one
hop, and nothing enforces that it will.

**Derive `chain` from the destination address at the app boundary.** Rejected: ADR 0017 already
shows this value is payer-influencable, not connector-asserted, and there is no other source for it
that the connector itself trusts.

**Leave the gap open — per-packet logs and per-channel claims stand unjoined.** Rejected: this is
the status quo issue #535 was filed against. An operator holding both halves of the connector's own
records still could not answer the relay's original question, which defeats the point of keeping
better records than the headers ever were.

## Consequences

`docs/protocol/client-edge-spec.md` and `docs/architecture` state plainly that a terminating
connector tells the app nothing about the payment that brought a packet to it, so the next reader
does not re-propose a header. No production behavior changes for the app: nothing new is sent to
it, and nothing it previously received is removed (it never received payment attribution in the
first place). An operator joining `client_channel_id` in a `"packet"` log line to `GET /channels`'
`counterparty` can now answer "who paid for this delivery" from records this connector already
kept — the record issue #535 asked for, without the header issue #505 correctly declined to bring
back.
