# Connector configuration

**Status:** **Normative for its numbered rules.** Per [ADR 0047](../adr/0047-the-configuration-schema-is-implementation-detail-capabilities-are-law.md),
what binds is **what an operator can express**, not what the file looks like. Per
[ADR 0045](../adr/0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md), a behavioural
rule is normative prose until a vector covers it — and configuration is **not vectorable**, so these
rules are prose-normative permanently rather than provisionally. **They do not enter the debt ledger.**

**Consumers:** anyone writing a second connector, and anyone operating this one. §1 is the contract;
§2 is this implementation's file, which binds nobody.

**Vocabulary:** [`CONTEXT.md`](../../CONTEXT.md). MUST, MUST NOT, SHOULD, MAY per RFC 2119.

---

## What this document is, and is not

A second implementation of TOON is **not** required to read this connector's TOML. It is required to
be configurable to _do_ what this connector can be configured to do, and to refuse what it must
refuse.

That distinction is not a hedge. Every fact a counterparty can observe — a route's price, a peering's
fee, whether an identity is required — **is** binding, and is specified where it is observed: in the
packet-flow, payment, node-self-description and client-edge documents. A peer must learn that this hop
charges a fee and refuses an over-cap packet with `T04`. It must not have to learn that the fee is
spelled `fee` inside a table spelled `[[peers]]`.

What remains here is the operator's side of the same facts: what must be expressible, what must be
rejected, and when.

---

## 1. The contract

### 1.1 Loading

**CF-01** `[connector]` — A connector MUST load its configuration **once**, validate it completely,
and hold the result immutable for the process lifetime. A configuration that reaches the runtime has
already answered every question about presence, range and mutual consistency.
([ADR 0009](../adr/0009-one-typed-config-file-no-environment-layer.md))

**CF-02** `[connector]` — A connector MUST NOT take configuration from the environment. There is no
override layer, and no precedence model, because two configuration surfaces means a class of bug where
the deployed value is not the value anyone read.

**CF-03** `[connector]` — Reload is a restart. Anything that must change while running changes through
the operator surface, where the change is authenticated and audited.

**CF-04** `[operator]` — Secrets are referenced **by location** — a file path or a key-management
identifier — and never written inline.

**CF-05** `[connector]` — Conveniences MUST be resolved at load, so the runtime sees only primitives
and the packet path stays topology-blind.

### 1.2 Identity and signing

**CF-06** `[connector]` — A connector MUST be configurable with an identity key, and **one key serves
every purpose this connector signs for**: the key a packet is sealed to, the key its outbound claims
are signed with, and the key its self-description publishes. A second key minted for one surface is a
defect, not a feature.
([ADR 0018](../adr/0018-a-payload-is-sealed-to-the-terminating-connector.md),
[ADR 0050](../adr/0050-a-connectors-url-resolves-to-its-self-description.md))

**CF-07** `[connector]` — A connector MAY hold no identity key. It then cannot open a sealed payload
and MUST answer a termination it cannot open with an unsealed reject naming where to ask.
([ADR 0054](../adr/0054-an-unsealed-termination-reject-answers-where-to-ask.md))

### 1.3 Facts a node cannot introspect

**CF-08** `[operator]` — A connector MUST be configurable with its own **public** ILP address(es) and
its **public** client-edge endpoints, HTTP and BTP. A node cannot derive these: a container sees
`0.0.0.0:4000` and a private network, never `https://proxy.example/ilp`.

**CF-09** `[connector]` — These facts, and no others about software behind the connector, are what the
node self-description publishes. A connector describes **itself**.
([ADR 0050](../adr/0050-a-connectors-url-resolves-to-its-self-description.md))

### 1.4 Routes

**CF-10** `[operator]` — A route MUST be expressible as a prefix plus exactly one of:

- a **handler** and a **price** — the route terminates here; or
- a **peer** and a **fee** — the route is forwarded to that peer.

**CF-11** `[connector]` — A route that names both, or neither, MUST be refused at load. A terminated
route with no price MUST be refused: a route is never silently free.
([ADR 0020](../adr/0020-a-price-is-flat-and-attaches-to-a-handler.md))

**CF-12** `[connector]` — Two routes MUST NOT claim the same prefix, whatever their kind. App routes
and peer routes share one prefix namespace.

**CF-13** `[operator]` — A price attaches to a **handler**, and an operator charges differently for
different work by publishing a route per handler. A connector MUST NOT let one route's price vary with
what a packet carries — that is how it prices without ever interpreting what it carries.

**CF-14** `[connector]` — Two routes naming the same handler MUST agree on its price.

**CF-15** `[operator]` — A route MAY require a specific client transport. A connector that pins one
MUST publish the requirement in its self-description; enforcing a requirement it does not advertise is
the defect that refused every relay publish on the devnet fleet.

### 1.5 Peerings

**CF-16** `[operator]` — A peering MUST be expressible as: a peer id, a **counterparty key**, a
carriage to reach it on, a fee, and a cap. A peering is created by an operator and by nothing else —
it cannot be bought, learned, earned, or announced into existence.
([ADR 0043](../adr/0043-purchasable-peering-is-removed.md), [ADR 0006](../adr/0006-the-connector-is-mechanism-not-policy.md))

**CF-17** `[connector]` — A peering's carriage is **BTP over `wss://`** or **ILP-over-HTTP over
`https://`**. A connector MAY expose both. Below the transport there MUST be one pipeline: a PREPARE
that arrived over HTTP is indistinguishable from one that arrived over BTP, and behaviour present on
one carriage and not the other is a defect rather than a property of the carriage.
([ADR 0027](../adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md))

**CF-18** `[connector]` — A plaintext peer endpoint (`ws://`, `http://`) MUST be refused. A connector
MAY offer a **node-wide** opt-in for loopback and test use; it MUST NOT offer a per-peering one, which
would read as an ordinary property of that peering and be copied into production one peer at a time. A
node with the opt-in set MUST log every plaintext peering at startup.

**CF-19** `[connector]` — A cap MUST be expressible per peering, MUST have a default, and MUST be
greater than zero. A cap of zero is not a smaller cap; it is a peering that can carry nothing.

**CF-20** `[connector]` — A connector MUST NOT raise its own cap. The number comes from outside —
the configuration file, or a controller writing through the operator surface. A cap that grows with
demonstrated good behaviour is a trust mechanism, and trust is policy.
([ADR 0049](../adr/0049-the-cap-bounds-one-packet-is-discovered-by-t04-and-is-set-from-outside.md))

### 1.6 Channels

**CF-21** `[operator]` — A connector MUST distinguish, in configuration, three channel roles:

| role               | means                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| **peer channel**   | which channel a peer's claims are judged against, and the key they verify under |
| **client channel** | which channel a client's claims are judged against                              |
| **pay channel**    | a channel this connector pays _from_, as a client of another node               |

**CF-22** `[connector]` — These books MUST NOT share ids. A channel in two roles is a namespace
collision and MUST be refused at load.

**CF-36** `[connector]` — A row in **any** of the three books MUST be refused at load, by name, if
the connector configures no settlement for that row's own chain. The settlement configuration is
where the connector's on-chain identity on that chain comes from (CF-24, and there is no second key
— ADR 0030), so without it the connector is not a participant of the channel: it could verify the
claims and never redeem one, rendering carriage for money it cannot collect. The rule is per chain
and no wider, and it does not depend on which book the row is in — see
[`peer-carriage-spec.md` §11.1](peer-carriage-spec.md) for the per-book consequences and why the
client book's declared-channel latitude (CF-23's "a configured row", and the deposit-cap exemption)
does not reach it. ([issue #1138](https://github.com/toon-protocol/connector/issues/1138))

**CF-23** `[connector]` — A claim's signature MUST be verified against **this connector's own record
of the channel** — a configured row, or a channel resolved from chain — and never against anything the
claim declares about itself.
([ADR 0052](../adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md))

### 1.7 Settlement

**CF-24** `[operator]` — Settlement MUST be configurable **per chain**, each with its own endpoint,
contracts, token and key.

**CF-25** `[connector]` — A connector MUST verify its settlement configuration against the chain at
startup and MUST refuse to boot on a disagreement — a token's decimals, a resolved contract. Nothing
downstream may then ask whether these facts are true.

**CF-26** `[connector]` — A fact the settlement backend already holds MUST NOT be declared a second
time elsewhere in the configuration. Two declarations of one fact is how a mainnet node comes to
announce itself as devnet.

### 1.8 Permissionless payment

**CF-27** `[connector]` — A connector MUST accept payment from a buyer it has never heard of, whose
channel it resolves from chain. Registration with the operator is never a precondition for paying.
([ADR 0052](../adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md))

**CF-28** `[connector]` — A connector MUST bound the chain lookups an unidentified sender can cause,
and MUST refuse rather than serve when that bound is reached. The bound's existence and its refusal
behaviour bind; the numbers are policy. Without it, CF-27 asks an operator to absorb unbounded cost
from strangers.

**CF-29** `[operator]` — A client identity MUST be expressible, and MUST be optional. An identity
**identifies**; it authorises nothing and cannot substitute for a claim. An empty secret means the
identity is a name, not a credential.

### 1.9 The operator surface

**CF-30** `[operator]` — Read authority and write authority MUST be separately configurable. A
credential that can inspect MUST NOT thereby be able to mutate.
([ADR 0008](../adr/0008-operator-surface-splits-read-from-write.md))

**CF-31** `[connector]` — The operator surface MUST be omittable. A node configured without one
exposes no operator surface at all, rather than an unauthenticated one.

**CF-32** `[connector]` — A runtime-written peer or route MUST NOT take a key the configuration file
owns. A colliding write is refused outright.
([ADR 0034](../adr/0034-a-runtime-peer-route-table-never-shadows-the-config-file.md))

**CF-33** `[connector]` — On load, a durable runtime row whose key the configuration file owns MUST be
**deleted**, not shadowed, and the deletion MUST be recorded where an operator will see it. Ownership
is permanent, not a precedence that flips back when the key is removed.

### 1.10 What a connector must refuse

**CF-34** `[connector]` — Every rule above whose verb is _refuse_ is a **load-time** failure that names
what is wrong. A connector MUST NOT start with a configuration it has not fully accepted.

**CF-35** `[connector]` — A connector SHOULD refuse a **removed** configuration key by name rather than
ignoring it. This is a convention of this implementation rather than protocol law — it binds nobody
else, because nobody else has these keys — and it is what stops an operator's committed file silently
changing meaning under an upgrade.

---

## 2. This implementation's file

**Non-normative.** Everything below is how _this_ connector spells §1. A second implementation may
spell it however it likes.

### 2.1 Top level

| key                                        | type                                  | required | expresses                                            |
| ------------------------------------------ | ------------------------------------- | -------- | ---------------------------------------------------- |
| `client_edge_addr`                         | socket address                        | yes      | where the client edge binds — **not** its public URL |
| `[signer]`                                 | table                                 | yes      | CF-06, the one identity key                          |
| `[[routes]]`                               | array of tables                       | —        | CF-10 – CF-15                                        |
| `[[peers]]`                                | array of tables                       | —        | CF-16 – CF-20                                        |
| `[[peer_channels]]`                        | array of tables                       | —        | CF-21, the peer book                                 |
| `[[client_channels]]`                      | array of tables                       | —        | CF-21, the client book                               |
| `[[pay_channels]]`                         | array of tables                       | —        | CF-21, channels this node pays from                  |
| `[[client_identities]]`                    | array of tables                       | —        | CF-29                                                |
| `[settlement.evm]` / `[settlement.solana]` | tables                                | —        | CF-24, CF-25                                         |
| `[operator]`                               | table                                 | no       | CF-30, CF-31                                         |
| `[node]`                                   | table                                 | —        | CF-08, the facts a node cannot introspect            |
| `peer_expose`                              | `"neither"`/`"btp"`/`"http"`/`"both"` | no       | CF-17                                                |
| `peer_allow_plaintext_endpoints`           | bool                                  | no       | CF-18's node-wide opt-in                             |
| `state_dir`                                | path                                  | no       | where durable state lives                            |

### 2.2 Local operational knobs

Visible to nobody outside the process, and **not** part of §1. They shape this connector's own resource
use and belong in an operator's guide rather than a protocol specification.

`channel_liveness_ttl_secs` · `channel_serve_stale_secs` · `channel_reattempt_interval_ms` ·
`unresolvable_lookup_budget_per_signer` · `unresolvable_lookup_budget_total` ·
`unresolvable_lookup_budget_window_secs` · `unresolvable_lookup_budget_max_wait_ms` ·
`btp_session_window`

`btp_session_window` splits, and shows the general shape: **the existence of an in-flight limit and
what a connector does when it is exceeded are law** (client-edge specification); the number that sets
it is not. _The limit is law, the number is policy._

### 2.3 Tombstones

Parsed **solely to be rejected by name**, per CF-35. Finding one of these identifiers in the tree is
finding a tombstone, not a live mechanism.

| key                                 | removed by                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `peer_wire_addr`                    | [ADR 0027](../adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md) |
| `ceiling`, `flush_interval_ms`      | [ADR 0033](../adr/0033-the-exposure-machinery-is-retired-not-restated.md)                        |
| `[peer_sale]`                       | [ADR 0043](../adr/0043-purchasable-peering-is-removed.md)                                        |
| `apex`, `[[children]]`              | [ADR 0009](../adr/0009-one-typed-config-file-no-environment-layer.md)'s update (#1057)           |
| `claim_enforcement`                 | [ADR 0042](../adr/0042-a-packet-carries-its-claim.md) item 4 (#1062 decided, #1077 deleted)      |
| the announce-only `[announce]` keys | [ADR 0046](../adr/0046-the-kind-10032-announce-is-removed-a-connector-needs-no-relay.md)         |

---

## 3. Consistency

This document uses exactly the vocabulary of [`CONTEXT.md`](../../CONTEXT.md) and implements
[ADR 0009](../adr/0009-one-typed-config-file-no-environment-layer.md),
[ADR 0034](../adr/0034-a-runtime-peer-route-table-never-shadows-the-config-file.md) and
[ADR 0047](../adr/0047-the-configuration-schema-is-implementation-detail-capabilities-are-law.md).

**Coverage:** none of CF-01 – CF-36 is vectored, and none ever will be. Configuration is not a wire
surface — you cannot express "this key is refused by name" as a byte fixture — so per
[ADR 0045](../adr/0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md) these rules are
prose-normative **permanently**, not provisionally, and do not enter the debt ledger. What _is_
vectorable is the observable consequence of a configuration — a price answered, a `T04` refused — and
that belongs to the documents where those are specified.

**Not yet built**, and marked so rather than described in the present tense: `[node]` (§2.1) is
[ADR 0050](../adr/0050-a-connectors-url-resolves-to-its-self-description.md)'s rename of `[announce]`
(#1080); CF-33's load-time reconciliation is #1076; CF-20's runtime-settable cap is #1079; the
`apex`/`[[children]]` tombstone is #1075. (`claim_enforcement`'s tombstone was #1077 and has
landed.)
