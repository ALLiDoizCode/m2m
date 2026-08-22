# Payment

**Status:** **Normative for its numbered rules.** Absorbs `peer-semantics-pre-868.md` §5.2 and the
shape of `money-model-pre-868.md` — the joining-piece role, not its text. Both are frozen history
(issues #1056, #1065); this document is what describes what money does **now**.

**Coverage:** none of PM-01 – PM-22 is vectored except where noted — the EIP-712 claim digest and the
peer-carriage claim framing are, and are the only payment facts under the cross-repo contract today.
The rest enter [ADR 0045](../adr/0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md)'s
debt ledger; issue #1084 owns the order.

**Vocabulary:** [`CONTEXT.md`](../../CONTEXT.md). MUST, MUST NOT, SHOULD, MAY per RFC 2119.

---

## 1. What money is here

A **payment channel** is a two-party agreement anchored on a chain that lets value move between the
parties many times while touching the chain only to open, top up and close. A **claim** is a signed
statement of that channel's cumulative state, handed from payer to payee.

**PM-01** `[any participant]` — Each claim supersedes the last. A lost claim costs nothing and a
replayed claim gains nothing.

**PM-02** `[connector]` — **Claims are the source of truth.** Balances are a **projection** — derived
by replaying the journal, never a second store that can disagree with it. Recovery is replay, not
reconciliation.
([ADR 0005](../adr/0005-claims-are-truth-balances-are-a-projection.md))

**PM-03** `[connector]` — The **journal** is the only money state a connector persists: what was
signed or is otherwise irreversible — claims sent, claims accepted, and the watermarks that came with
them.

**PM-04** `[connector]` — A connector MUST refuse to start on a corrupt journal. A damaged record of
what was signed is not recoverable by guessing.

---

## 2. What authorises a packet

**PM-05** `[connector]` — A **verified claim** authorises a packet. An identity does not, and cannot
substitute for one.
([ADR 0052](../adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md))

**PM-06** `[connector]` — A claim's signature MUST be verified against **this connector's own record
of the channel** — a configured row, or a channel resolved from the chain its settlement backend
already names — and **never** against anything the claim declares about itself.

**PM-07** `[connector]` — **Unverifiable is never accepted, by configuration, flag or build profile.**
A registry with neither a record nor a source refuses; a source that cannot answer — an unreachable
RPC endpoint — refuses the claim it was asked about, distinguishably and never silently. There is no
degraded mode.

**PM-08** `[connector]` — A **nonce** orders claims within a channel, and a payee accepts a claim only
if its nonce advances its **watermark**. A byte-identical retransmit at an accepted nonce is
idempotent; a _different_ claim at an accepted nonce MUST be refused and MUST NOT move the watermark.

---

## 3. What a claim signs

**PM-09** `[any participant]` — An **EVM** claim signs the EIP-712 `BalanceProof` digest, covering
`channel_id`, `nonce`, `transferred_amount` — **and `chain_id` and `token_network_address` through the
domain separator.** Changing any one of them invalidates a prior signature.
([ADR 0024](../adr/0024-peer-wire-claims-sign-the-eip-712-balance-proof.md)) — **vectored.**

**PM-10** `[any participant]` — A **Solana** claim signs an Ed25519 message that MUST bind the
settlement program and the cluster alongside the channel account, nonce and transferred amount. A
claim's signature MUST NOT verify against a channel account alone.
([ADR 0053](../adr/0053-a-solana-claim-binds-its-domain-the-way-an-evm-claim-does.md)) — **not yet
built** (#1082); today the message binds neither.

**PM-11** `[connector]` — A claim's declared `blockchain` is a **routing hint, never a security
boundary.** It selects which verifier runs; the signed bytes underneath must commit to the chain that
verifier is actually on.

> PM-10 and PM-11 together are why issue #975 asks for the wrong fix. The declared `cluster` is not
> signed over, so checking it catches an honest misconfiguration and nothing else — a forger declares
> whichever cluster the receiver expects and the signature still verifies. **A check on an unsigned
> field reads like protection and is not.**

---

## 4. A packet carries its claim

**PM-12** `[any participant]` — The claim that pays for a packet travels **with** it, not behind it.
Nothing is owed between packets, so there is no window in which a counterparty can walk away.
([ADR 0042](../adr/0042-a-packet-carries-its-claim.md))

**PM-13** `[connector]` — **One claim per packet, never batched.**
([ADR 0004](../adr/0004-value-moves-on-fulfilment.md), the half that survives)

**PM-14** `[connector]` — An arrival at a **priced termination** whose claim does not cover the
route's price MUST be refused `F03` before delivery.
([ADR 0029](../adr/0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md)) — **live.**

**PM-15** `[connector]` — An arrival with **no** covering claim at all MUST be refused `F06`, with the
greeting that states the terms.

> **State of PM-12, stated plainly rather than aspirationally.** The rule is **live at a priced
> termination** and **not yet built for a forwarded arrival** — a connector still carries a
> forwarded packet whose claim covers nothing, because the gate filters on a terminated route.
> **What is built is the other side of the same hop**: a node with a `[[pay_channels]]` row for a
> peering covers every PREPARE it forwards to it, minted before the packet is sent and never
> recovered after a refusal (issue #881). So "a claim trails its fulfilment" is now true only of a
> peering nobody wrote that row for. What no arriving hop yet does is _require_ one.
> [ADR 0042](../adr/0042-a-packet-carries-its-claim.md) is a target record and says so; the lock
> epic (#1031) is the vehicle.

**PM-16** `[connector]` — **Exposure and its ceiling are retired**, not restated. Nothing tracks value
delivered but unclaimed, and no configuration bounds it. A `ceiling` or `flush_interval_ms` key is
refused by name.
([ADR 0033](../adr/0033-the-exposure-machinery-is-retired-not-restated.md))

---

## 5. Fee, price and cost

**PM-17** `[connector]` — A **fee** buys carriage across one peering relation. A **price** buys the
work at the end of a terminated route. Both are **flat per packet**.

**PM-18** `[operator]` — Pricing granularity is **handler** granularity: one handler, one price. An
operator charges differently for different work by publishing a route per handler — never by letting
one route's price vary with what a packet carries. That is how a connector prices without ever
interpreting what it carries.
([ADR 0020](../adr/0020-a-price-is-flat-and-attaches-to-a-handler.md))

**PM-19** `[client]` — **Cost** is what a caller must send for a packet to be delivered: every hop's
fee plus the terminating route's price. A reject states the cost of the path it travelled — **the sum
only**, never the per-hop breakdown and never the fee/price split. That is what a **probe** discovers.
([ADR 0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md))

**PM-20** `[connector]` — A **forwarded** route is priced at the client edge, and carries no more than
it was paid. The invariant `price − fee >= next hop price` is what protects a client across a path,
and is why a client needs no minimum-delivery floor of its own.
([ADR 0028](../adr/0028-a-forwarded-route-is-priced-at-the-client-edge.md))

---

## 6. What the app is told

**PM-21** `[connector]` — A delivery whose covering client claim **this** connector verified itself
states `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain` to the app. A delivery this connector did
not verify states **none of the three** — an unverified payment is stated by nobody.
([ADR 0040](../adr/0040-a-verified-payment-is-stated-to-the-app.md))

**PM-22** `[app]` — An app MUST NOT assume those headers are present. Their absence means _this
connector cannot vouch for the payer_, not that the work was unpaid: whatever arrives at a handler was
paid for, at that handler's one price.

---

## 7. Settlement

**Settlement** is making a claim's promised value real on chain — redeeming the latest claim, or a
cooperative close. Rare and deliberate, the opposite of claims, which are constant and automatic.

A connector holds a **signer** and settlement backends: a local key or a key-management backend, with
rotation, and nothing more. **No mnemonic recovery, no seed management, no human authentication** —
those belong to an end-user wallet, which a connector is not.
([ADR 0012](../adr/0012-a-signer-and-a-treasury-not-a-wallet.md), the half that survives)

### The lock, and its two deadlines

A covered forward **locks** value rather than transferring it, so value releases against a verified
fulfilment (#1031, and the record #1034 will produce). Its expiry semantics are decided:

```
lock timeout  ≥  packet expiry  +  margin
```

These are not competing deadlines. **Packet expiry** bounds how long a _hop_ waits for a fulfilment —
packet-plane, per-hop, strictly decreasing along the path. **Lock timeout** bounds how long _capital_
stays locked before the payer can reclaim it without cooperation — settlement-plane. The on-chain
figure is derived from and strictly bounds the ledger-layer one.

**A node that cannot satisfy the relationship refuses to forward** rather than locking with an unsafe
timeout — _refuse, not refund_. And each lock carries **its own** deadline: packet expiries vary per
packet, while a channel's settlement timeout is a single constant used for close.

---

## 8. Consistency

Uses exactly the vocabulary of [`CONTEXT.md`](../../CONTEXT.md) and implements
[ADR 0004](../adr/0004-value-moves-on-fulfilment.md),
[0005](../adr/0005-claims-are-truth-balances-are-a-projection.md),
[0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md),
[0012](../adr/0012-a-signer-and-a-treasury-not-a-wallet.md),
[0020](../adr/0020-a-price-is-flat-and-attaches-to-a-handler.md),
[0024](../adr/0024-peer-wire-claims-sign-the-eip-712-balance-proof.md),
[0028](../adr/0028-a-forwarded-route-is-priced-at-the-client-edge.md),
[0029](../adr/0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md),
[0033](../adr/0033-the-exposure-machinery-is-retired-not-restated.md),
[0040](../adr/0040-a-verified-payment-is-stated-to-the-app.md),
[0042](../adr/0042-a-packet-carries-its-claim.md),
[0052](../adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md) and
[0053](../adr/0053-a-solana-claim-binds-its-domain-the-way-an-evm-claim-does.md).

**Not yet built:** PM-10's Solana domain binding (#1082), PM-12's forwarded half (#1031), and the
lock (#1031, #1035–#1037). Each says so above rather than being written in the present tense.
