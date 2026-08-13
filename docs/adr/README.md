# Architecture decision records

36 records, and they do **three different jobs**. Most readers only need one group.

The numbers are permanent and are never reused or renumbered — they are cited over a thousand
times across this repo and from `toon-meta`, `relay` and `store`. This index groups them by
scope; it does not move them.

| If you are…                                                                 | Read                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| changing the connector's code or structure                                  | **[Connector architecture](#connector-architecture)** — 11 records |
| writing or fixing another implementation (a client SDK, a second connector) | **[Protocol law](#protocol-law)** — 22 records                     |
| deploying, migrating or operating the fleet                                 | **[Fleet and operations](#fleet-and-operations)** — 3 records      |

> **Scope note.** A record's group says _who is bound by it_, not where it is implemented.
> Protocol records are implemented in this repo but bind every implementation, which is why
> they are cited from outside it. ADR 0021 is the tiebreaker for all of them: **vectors are
> normative, prose is not.**

---

## Connector architecture

Internal to this codebase. Changing one of these changes how the connector is built; it does
not change what anything else must do.

| #                                                                        | Decision                                                               | Status                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------- |
| [0001](0001-rust-workspace-library-first.md)                             | The connector is a Rust library first, a binary second                 | current                |
| [0002](0002-drop-mina-from-the-rust-connector.md)                        | Settles on EVM and Solana only; Mina is dropped                        | current                |
| [0005](0005-claims-are-truth-balances-are-a-projection.md)               | Claims are the source of truth; balances are a projection              | current                |
| [0006](0006-the-connector-is-mechanism-not-policy.md)                    | The connector is mechanism; discovery and route policy live outside it | current                |
| [0007](0007-testing-doctrine-fakes-yes-mocks-no.md)                      | Property tests over a pure core; fakes are allowed, mocks are not      | current                |
| [0008](0008-operator-surface-splits-read-from-write.md)                  | The operator surface splits read authority from write authority        | current                |
| [0009](0009-one-typed-config-file-no-environment-layer.md)               | Configuration is one typed file with no environment-variable layer     | current                |
| [0012](0012-a-signer-and-a-treasury-not-a-wallet.md)                     | The connector holds a signer and a treasury, not a wallet              | current                |
| [0014](0014-metrics-surface-and-packet-correlated-logs.md)               | The metrics surface is decided, not accreted                           | current                |
| [0015](0015-read-mostly-state-is-a-swapped-snapshot.md)                  | Read-mostly state is a swapped snapshot; the packet path never locks   | current                |
| [0034](0034-a-runtime-peer-route-table-never-shadows-the-config-file.md) | A runtime peer/route table never shadows the config file               | current — extends 0009 |

---

## Protocol law

These bind **every** implementation, not just this one. A client SDK, a second connector, or a
spec written in another repo is constrained by them. This is the group most often cited from
outside this repository.

### The money model

| #                                                                                | Decision                                                                             | Status                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [0004](0004-value-moves-on-fulfilment.md)                                        | Value moves on fulfilment, one claim per packet                                      | current                                                                                                             |
| [0010](0010-flat-per-packet-fee-and-minimum-delivery.md)                         | A hop charges a flat per-packet fee; packets declare a minimum delivery              | current                                                                                                             |
| [0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)                 | Rejects accumulate fees; a probe is how cost is discovered                           | current                                                                                                             |
| [0020](0020-a-price-is-flat-and-attaches-to-a-handler.md)                        | A price is flat, attaches to a handler, and buys an answer                           | current                                                                                                             |
| [0024](0024-peer-wire-claims-sign-the-eip-712-balance-proof.md)                  | Peer-wire claims sign the EIP-712 balance-proof digest                               | current                                                                                                             |
| [0028](0028-a-forwarded-route-is-priced-at-the-client-edge.md)                   | A forwarded route is priced at the client edge, and carries no more than it was paid | current                                                                                                             |
| [0029](0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md) | A peer-wire arrival to a priced termination must cover its price                     | **partly retired** — its `F03` price check stands; the exposure ceiling and `T04` it references are retired by 0033 |
| [0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md)  | A peer PREPARE arrives with its covering claim, or it is greeted                     | current — **retires the credit window**                                                                             |
| [0033](0033-the-exposure-machinery-is-retired-not-restated.md)                   | The exposure machinery is retired, not restated                                      | current — **retires `ceiling` and `flush_interval_ms`**                                                             |
| [0035](0035-request-request-binding-ships-no-new-mechanism.md)                   | Request-request binding ships no new mechanism                                       | current — the claim gate already closes the threat                                                                  |

### The wire and its carriage

| #                                                                                     | Decision                                                                    | Status                                                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [0003](0003-clean-room-peer-wire-versioned-client-edge.md)                            | The peer wire is redesigned freely; the client edge is versioned            | **partly superseded** — the peer-wire half is reversed by 0027                |
| [0021](0021-vectors-are-normative-prose-is-not.md)                                    | Vectors are normative; prose is not                                         | current — **the tiebreaker for this whole group**                             |
| [0023](0023-oer-length-determinants-are-canonical.md)                                 | OER length determinants are canonical, for every consumer                   | current                                                                       |
| [0026](0026-client-btp-rides-the-client-edge-peers-stay-on-the-peer-wire.md)          | Client BTP rides the client edge; peers stay on the peer wire               | **partly superseded** — conclusion revised by 0027, architecture reaffirmed   |
| [0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md) | Connectors peer over BTP or ILP-over-HTTP; the raw-TCP peer wire is deleted | current — but the flush timer and ceiling it reasons with are retired by 0033 |

### Payload, envelope and termination

| #                                                                       | Decision                                                               | Status                                                                                                                    |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [0016](0016-payload-opacity-is-a-property-of-carriage.md)               | Payload opacity is a property of carriage                              | **partly superseded** — first half stands and is made structural by 0018; its client-edge-v1 ruling is superseded by 0017 |
| [0018](0018-a-payload-is-sealed-to-the-terminating-connector.md)        | A packet's payload is sealed to the terminating connector              | current                                                                                                                   |
| [0019](0019-a-terminating-connector-derives-the-fulfilment.md)          | A terminating connector derives the fulfilment it is paid against      | current                                                                                                                   |
| [0025](0025-an-envelope-target-is-confined-beneath-the-handler-path.md) | An envelope target is confined beneath the route's handler path        | current                                                                                                                   |
| [0032](0032-a-client-destination-is-never-a-route-termination.md)       | A client destination is never a route termination                      | current — bounds 0018 and 0019                                                                                            |
| [0036](0036-a-paid-deliverys-attribution-stays-on-the-connector.md)     | A paid delivery's attribution stays on the connector, never on the app | current — extends 0014                                                                                                    |

### Discovery

| #                                                        | Decision                                                 | Status  |
| -------------------------------------------------------- | -------------------------------------------------------- | ------- |
| [0022](0022-a-connector-answers-it-does-not-announce.md) | A connector answers when asked; it still never announces | current |

---

## Fleet and operations

Neither connector-internal nor wire law: decisions about how the fleet is run, migrated, or
how another repository is regarded.

| #                                                                    | Decision                                                                | Status                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| [0013](0013-cut-over-through-a-parallel-address-space.md)            | The Rust fleet runs in parallel under its own address space             | current                                                |
| [0017](0017-the-typescript-connector-is-a-prototype.md)              | The TypeScript connector is a prototype, not a reference implementation | current — a judgement about a **different** repository |
| [0030](0030-an-operator-announces-a-node-the-node-still-does-not.md) | An operator announces a node; the node still does not                   | current — the operational counterpart to 0022          |

---

## Records carrying superseded reasoning

Five records are still authoritative in part but argue from premises that later records
retired. Read the superseding record first, or the reasoning will mislead you.

| Record | Read this first                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| 0003   | [0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md)                                     |
| 0016   | [0017](0017-the-typescript-connector-is-a-prototype.md), [0018](0018-a-payload-is-sealed-to-the-terminating-connector.md) |
| 0026   | [0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md)                                     |
| 0027   | [0033](0033-the-exposure-machinery-is-retired-not-restated.md)                                                            |
| 0029   | [0033](0033-the-exposure-machinery-is-retired-not-restated.md)                                                            |

---

## Related, and not an ADR

`docs/protocol/` holds the specifications the protocol records above are the decision trail
for — `client-edge-spec.md`, `peer-carriage-spec.md`, `peer-wire-spec.md`, `money-model.md`,
and `wire-vectors.md`. Per ADR 0021 those prose specs are **non-normative**; the committed
vectors are the contract.

## Conventions

- **Numbers are permanent.** Never renumber, never reuse, never delete a record. Supersede it
  with a new one and add a note at the top of the old one.
- **A record states its decision in its first paragraph**, before any context or options.
- **Amendments are appended in place** under an `## Update (issue #NNN)` heading rather than
  rewriting the original decision, so the trail stays readable.
