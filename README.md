# Connector

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A payment router for agent networks: an [Interledger](https://interledger.org) connector that
forwards value-bearing packets between peers, terminates routes in front of
payment-oblivious apps, charges for them, and settles the balance on chain.

**This is a Rust repository.** The connector is a Cargo workspace under [`crates/`](crates/),
built as one static binary that reads one TOML file. The TypeScript connector that used to live
here was a prototype and has been removed —
[ADR 0017](docs/adr/0017-the-typescript-connector-is-a-prototype.md), #465 and #543.
`@toon-protocol/connector` remains on npm at its last release (4.0.0) for existing clients, but
its source is only in git history, and nothing in this repository implements its wire.

## What the connector does

- **Routes.** Longest-prefix match on an ILP address (`g.example.app`) picks either a **peer** to
  forward to or an **app** to terminate at. Routes are static configuration — the connector is
  mechanism, not policy ([ADR 0006](docs/adr/0006-the-connector-is-mechanism-not-policy.md)); it
  neither discovers nor advertises them
  ([ADR 0022](docs/adr/0022-a-connector-answers-it-does-not-announce.md)).
- **Charges.** A **fee** is flat, per packet, per peering relation; a **price** is flat and
  attaches to a terminated route's handler. Neither is a percentage and neither is per byte
  ([ADR 0010](docs/adr/0010-flat-per-packet-fee-and-minimum-delivery.md),
  [ADR 0020](docs/adr/0020-a-price-is-flat-and-attaches-to-a-handler.md)). You pay for an answer,
  not for the answer you wanted: a `404` from the app is a real answer and costs the same as a
  `200`.
- **Keeps the payload sealed.** A packet's `data` is a gift wrap sealed to the **terminating**
  connector's identity key, carrying a 32-byte shared secret and an OER-encoded request envelope
  ([ADR 0018](docs/adr/0018-a-payload-is-sealed-to-the-terminating-connector.md)). A forwarding hop
  sees opaque bytes — not the method, target, headers or size of what crossed it. The terminating
  connector opens it, makes exactly that HTTP request of the app, and seals the app's complete
  response back under the same secret.
- **Derives its own fulfilment.** The terminating connector derives the packet's 32-byte
  fulfilment from that shared secret
  ([ADR 0019](docs/adr/0019-a-terminating-connector-derives-the-fulfilment.md)). The app supplies
  no preimage and is told nothing about the payment — no `TOON-Fulfillment`, no `X-TOON-Payer`,
  no headers of any kind that this connector adds.
- **Accounts and settles.** Fulfilments accrue as signed claims against a payment channel
  ([ADR 0004](docs/adr/0004-value-moves-on-fulfilment.md),
  [ADR 0005](docs/adr/0005-claims-are-truth-balances-are-a-projection.md)); the latest claim is
  redeemed on chain against a deployed `TokenNetwork`, reached through a registry.
  [`docs/protocol/money-model.md`](docs/protocol/money-model.md) walks one write end to end —
  client edge to terminating app — with a diagram.

## Build

Rust stable (CI pins nothing tighter than `dtolnay/rust-toolchain@stable`). Clone with
submodules — `packages/contracts` vendors OpenZeppelin and forge-std, and one test shells out to
`forge build`:

```bash
git clone --recurse-submodules https://github.com/toon-protocol/connector.git
cd connector
cargo build --workspace
```

The binary lands at `target/debug/connector` (`--release` for `target/release/connector`).

## Configure

One TOML file, read once at startup, fully validated, immutable for the process lifetime. There
is **no environment-variable override layer**
([ADR 0009](docs/adr/0009-one-typed-config-file-no-environment-layer.md)) — the only variable the
binary reads is `RUST_LOG`, and that only sets log verbosity. Unknown keys are a hard load
failure; the connector either runs with what you wrote or refuses to start and says why.

[`deploy/connector-rust/connector.toml`](deploy/connector-rust/connector.toml) is the annotated
template. A minimal file:

```toml
client_edge_addr = "0.0.0.0:3000"

[signer]
key_file = "/app/data/signer.key"   # 32 raw bytes, or 64 hex characters

[[routes]]
prefix      = "g.example.app"
handler_url = "http://app:3100"
price       = 100
```

| Key                     | Type        | Required  | Meaning                                                                                                       |
| ----------------------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `client_edge_addr`      | `host:port` | yes       | Where `POST /ilp`, `GET /ilp/btp` (and, if configured, the operator surface) listen.                          |
| `[signer]`              | table       | yes       | Exactly one of `key_file` or `kms_key_id` — a location, never a key value.                                    |
| `[[routes]]`            | array       | no        | See below.                                                                                                    |
| `apex`                  | ILP address | no        | Required only if `[[children]]` is used.                                                                      |
| `[[children]]`          | array       | no        | `{ name, handler_url, price }` — sugar for a route at `<apex>.<name>`.                                        |
| `[operator]`            | table       | no        | Absent ⇒ the operator surface is not mounted at all.                                                          |
| `peer_expose`           | string      | no        | `btp` / `http` / `both` / `neither` — which peer carriages this node listens for. Absent ⇒ `neither`.         |
| `[[peers]]`             | array       | no        | `{ id, endpoint, credential, … }` — the peerings `routes.peer_id` may name.                                   |
| `[[peer_channels]]`     | array       | no        | `{ peer_id, channel_id, counterparty_key, chain_id, token_network }` — required for every peering.            |
| `[settlement]`          | table       | no        | Absent ⇒ every channel operation answers `503`.                                                               |
| `[[client_channels]]`   | array       | no        | Absent ⇒ the client edge has a record of no channel, so it refuses every claim.                               |
| `[[client_identities]]` | array       | no        | `{ id, secret }` — the client-edge identities `POST /ilp` authenticates. Absent ⇒ every request is anonymous. |
| `state_dir`             | path        | see below | Where this node writes its claim journals. Required whenever `[[client_channels]]` is set.                    |

A `[[routes]]` entry sets **exactly one** of `handler_url` (terminate here) or `peer_id` (forward
there). A terminated route **must** carry a `price` — write `price = 0` if free is deliberate,
because it is never silently free. A forwarding route may carry a `fee` (default `0`).

A `[[peers]]` entry's `endpoint` is a URL whose **scheme** selects the carriage — `wss://` for BTP,
`https://` for ILP-over-HTTP (ADR 0027); the old `SocketAddr`-shaped `addr` and the top-level
`peer_wire_addr` are refused by name — `peer_wire_addr` is still parsed, but only so a config that
still sets it fails at boot with a named error rather than being silently ignored. Every peering
needs a `credential` and at least one `[[peer_channels]]` row, because role is decided by
authentication _and_ a channel binding. A `credential` sets **exactly one** of `secret_file` (a
path to the secret — what a deployed node uses, so the peering can live in a committed config) or
`secret` (the literal). See
[`docs/operators/btp-peer-transport-bringup.md`](docs/operators/btp-peer-transport-bringup.md).

`peer_expose` and `credential` are **peer-role** settings and nothing else. `peer_expose` opens no
port: it turns on peer handling, behind the credential check, on the listeners this node already
serves. A node that leaves it at its `neither` default still serves clients over BTP, and a node
that sets it still admits a client that presents no credential at all — see "The client edge"
below.

`[settlement]` configures one or more chains, in either of two shapes (issue #628) — Mina is out of
scope per [ADR 0002](docs/adr/0002-drop-mina-from-the-rust-connector.md) either way. The legacy
flat shape — `chain = "evm"`, `rpc_url`, `contract_address` (the **`TokenNetworkRegistry`**, which
`getTokenNetwork(token)` is called on — not a channel contract), `token_address`, non-zero
`decimals`, and a `[settlement.key]` table — is frozen at `"evm"` and never accepts `"solana"`. To
settle on Solana, or on both chains at once, use the keyed shape instead: `[settlement.evm]` (the
same fields as the legacy shape, minus `chain`) and/or `[settlement.solana]` (`rpc_url`,
`program_id` — the deployed `payment-channel` program, in place of `contract_address` —
`token_address`, `decimals`, `[settlement.solana.key]`). Either shape's `key` table takes the same
`key_file`/`kms_key_id` choice as `[signer]`. An absent `[settlement]` is fine; a present but wrong
one is a startup failure — `connector-cli` constructs a real backend for every chain configured,
EVM or Solana, before the node serves anything.

`decimals` is a declaration, not a conversion. Nothing scales by it: every amount on the value
path — route prices, claim amounts, channel deposits — is already in the settlement token's base
units, and [`docs/usdc-cross-chain-settlement.md`](docs/usdc-cross-chain-settlement.md)'s
"6 decimals everywhere" keeps those units uniform across chains, so there is nothing to convert.
It is checked instead: startup reads the token's own `decimals()` and refuses to start when the
two disagree, naming both. Write the scale the deployed token actually has — today, `6`.

`[[client_channels]]` is what makes a paid write possible: each entry names a payment channel this
node accepts client-edge claims on, and the counterparty whose signature it accepts on that
channel — `channel_id` (the on-chain 32-byte identifier), `counterparty` (a 20-byte EVM address),
`chain_id` and `token_network_address` (the EIP-712 domain the balance proof is signed under, per
[ADR 0024](docs/adr/0024-peer-wire-claims-sign-the-eip-712-balance-proof.md)). A claim's signature
is checked against that recorded counterparty and never against the signer the claim declares for
itself, and a claim naming a channel with no entry here is refused as unknown. A node configuring
none therefore accepts no paid write at all — deliberately, since the only alternative to "no
record of this channel" is believing what a claim says about itself.

`[[client_identities]]` names the senders `POST /ilp` recognises by credential rather than by
claim: each entry is an `id` a request presents in `ILP-Peer-Id` and the `secret` it must present
in `Authorization: Bearer <secret>` (an empty or omitted `secret` makes that identity
permissionless — the header may then be absent, mirroring BTP's `secret: ""` frame). A duplicated
`id` is refused at load. This is **not** what admits a request: a request presenting no
`ILP-Peer-Id` is anonymous, which is a first-class path — an unaffiliated buyer pays for a route
without registering with the operator first — so a node configuring none of these serves clients
exactly as it did before the section existed. What it changes is that an `ILP-Peer-Id` presented
and _not_ authenticated is refused **401**, before the route is looked up. Distinct from
`[[peers]]` (a peering this node dials, which has an endpoint) and from `[[client_channels]]`
(which channel a claim is judged against, never who presented it).

`state_dir` is where a claim's replay watermark is written down. Without it the watermarks live
only in process memory, so a restart resets every channel to "no claim ever seen" — and a channel
with no watermark accepts any nonce, which hands a client every claim it has already spent back
as free service. Config load therefore **refuses** a file that sets `[[client_channels]]` without
a `state_dir`, and startup refuses to boot at all if the directory cannot be written, naming the
path. Two append-only files live there: `client-edge-claims.log` (claims accepted at `POST /ilp`)
and `peer-claims.log` (the peer carriage's own `ClaimBook`). Both are replayed before the node
serves; a journal that cannot be read, or that carries a line this build cannot decode, is a
refusal to start rather than a silent restart from zero.

In a container this must be a **mounted volume**, not a path in the writable layer — a watermark
that dies with the container is the same defect one indirection down. The image runs as uid
`10001`, so a named volume (chowned automatically) is simpler than a host bind mount (`chown
10001:10001` it first).

> The `*.yaml` files under `config/` and `infra/linode-node/` are the **retired TypeScript
> connector's** configuration (`nodeId`, `btpServerPort`, `adminApi`). Only `*.toml` describes
> this binary. The `deploy/pay-edge/` and `deploy/node-quickstart/` bundles that used to be
> listed here are gone — see [`deploy/README.md`](deploy/README.md).

## Run

```bash
cargo run -p connector --bin connector -- path/to/connector.toml
```

(`--bin connector` is not optional: the package also builds `stub-app`, a payment-oblivious test
app used by the integration tests.) The positional argument is the config path — there is one
subcommand, `announce`, which publishes this node's discovery event instead of serving traffic; see
[`docs/operators/announcing-a-node.md`](docs/operators/announcing-a-node.md). A missing argument
prints the usage line and exits 1.

Logs are structured JSON on stdout, one object per line. Every line emitted while handling a
packet carries the same `correlation_id` — the packet's execution condition, hex-encoded — and
because that condition is invariant across hops, the same id appears in every connector that
handled the packet ([ADR 0014](docs/adr/0014-metrics-surface-and-packet-correlated-logs.md)). Set
`RUST_LOG=debug` for more.

To run it as a container instead, see
[`deploy/connector-rust/README.md`](deploy/connector-rust/README.md) — the published image is
`ghcr.io/toon-protocol/connector`, tagged `rust-sha-<short>` per commit and `rust-main` on the
default branch (#645). Pin an exact `rust-sha-` tag; `rust-main` moves. The separate
`ghcr.io/toon-protocol/connector-rust` package this used to name is retired and gets no new
builds.

## The client edge

What a client speaks to the connector it pays. Versioned rather than redesigned, because its far
end is software this repository does not ship
([ADR 0003](docs/adr/0003-clean-room-peer-wire-versioned-client-edge.md)). Six routes, all on
`client_edge_addr`: the three below (`POST /ilp`, `GET /ilp/identity`, `GET /ilp/routes/price`),
plus `POST /ilp/probe` (raises a `TOON-Accumulated-Cost` reject deliberately, for cost discovery),
`GET /ilp/btp` (the BTP carriage's websocket upgrade, ADR 0027 — also where a BTP peer rides this
listener, per [`docs/protocol/peer-carriage-spec.md`](docs/protocol/peer-carriage-spec.md)) and
`POST /ilp/claim-state` (a bulk, signature-authenticated read of claim state for channels the
caller controls). Full detail on all six:
[`docs/protocol/client-edge-spec.md`](docs/protocol/client-edge-spec.md).

**Opening a client BTP session takes no token.** `GET /ilp/btp` is permissionless: a client that
presents no credential at all — or the `auth` frame the deployed client sends with `secret: ""` —
is accepted and stays a client, its contents unverified. Nothing about the handshake is trusted.
What authorizes a **write** is the signed payment-channel claim on each frame, exactly as on
`POST /ilp` ([`client-edge-spec.md`](docs/protocol/client-edge-spec.md) §1.9 step 1: _"Authorization
to write comes from the claim, never the session"_). The `credential` in `[[peers]]` upgrades an
already-admitted session from client to peer; it is not what admits it. `[[client_identities]]` is
`POST /ilp`'s own authentication and does not gate this handshake either — the `auth` frame's
contents stay unverified.

### `POST /ilp`

Body: an OER-encoded ILPv4 PREPARE, `Content-Type: application/octet-stream`. Response: an
OER-encoded FULFILL or REJECT, also `application/octet-stream`, at HTTP **200** — an ILP-level
outcome is never an HTTP-level one.

- **400** — the body did not decode as a PREPARE.
- **401** — the request presented an `ILP-Peer-Id` that named no `[[client_identities]]` entry, or
  named one but did not present its secret. Answered before the route is looked up, so an
  unauthorised caller is never quoted a price instead.
- **402** — the request carried no claim header and addressed a route this connector both
  terminates and prices. The body is an x402 v2 `PaymentRequired` document
  (`application/json`), repeated base64-encoded in a `Payment-Required` response header, with a
  single `toon-channel` entry quoting the same price a real request would be charged.

A request pays with a claim in `ILP-Payment-Channel-Claim` (base64 JSON) or
`ILP-Payment-Channel-Claim-Wrapped` (NIP-59-wrapped; plaintext wins if both are present). The
claim is checked structure → freshness against the channel's watermark → value against the
route's price → signature, in that order, so a replay or an underpayment never costs a signature
verification. A failing claim rejects the packet before it reaches the app: `F03` for an
underpayment, `F01` for everything else.

### `GET /ilp/identity`

```json
{ "keyId": "...", "publicKey": "0x04..." }
```

The uncompressed secp256k1 public key a sender seals a packet's payload to. Distinct from the
operator surface's bearer-gated `GET /identity`, which answers a different question for a
different caller.

### `GET /ilp/routes/price?destination=<ILP address>`

```json
{ "destination": "g.example.app", "price": 100 }
```

Reads the same longest-prefix lookup that the x402 terms and the claim's value binding charge
against, so it never quotes a price a real request would not also be charged. **404** when no
locally-terminated route matches — it never fabricates a price for a route it does not serve.

## The operator surface

Mounted only when `[operator]` is configured, and **merged onto `client_edge_addr`** — there is
no second port. The split is read from write
([ADR 0008](docs/adr/0008-operator-surface-splits-read-from-write.md)):

- **Reads** need `Authorization: Bearer <bearer_token>` and nothing else:
  `GET /peers`, `/routes`, `/routes/leased`, `/routes/peers`, `/channels`, `/claims`, `/identity`,
  `/audit-log`, and `/metrics` (Prometheus text: `toon_packets_total`,
  `toon_packets_rejected_total`, `toon_fees_earned_total`, `toon_exposure` (always zero; kept for
  scrape-config stability, [ADR 0033](docs/adr/0033-the-exposure-machinery-is-retired-not-restated.md)),
  `toon_settlement_total`).
- **Writes** need an RFC 9421 HTTP Message Signature from an ed25519 key on `write_keys`, with
  the body bound by an RFC 9530 `Content-Digest`. A bearer token is never sufficient to move
  value. `POST /packets`, `/routes/leased`, `/peers`, `/routes/peers`, `/channels`, and — all
  under the channel they act on — `/channels/:id/fund`, `/channels/:id/redeem`,
  `/channels/:id/redeem-latest`, `/channels/:id/close`, `/channels/:id/cooperative-close` — plus
  `DELETE /peers/:id` and `DELETE /routes/peers/:prefix` (issue #884). Channel operations answer
  `503` when no `[settlement]` backend is configured.

`POST`/`DELETE /peers*` and `/routes/peers*` (issue #884) are the runtime-mutable, durable
peer/route table: unlike `/routes/leased` (a TTL-bound push that lapses on its own and never
survives a restart, ADR 0006), these persist to `state_dir` and are refused outright — never
silently accepted as a shadow — when they'd collide with a row the config file already owns
([ADR 0034](docs/adr/0034-a-runtime-peer-route-table-never-shadows-the-config-file.md)).

There is **no health endpoint** on either surface, and **no unauthenticated metrics path** on
either. `[operator]` is how a node opts into metrics at all: absent, `/metrics` is not mounted and
answers 404 rather than 401 ([ADR 0014](docs/adr/0014-metrics-surface-and-packet-correlated-logs.md)
— metrics are one more bearer-gated read, not a second differently-authenticated surface). The
client edge's two free `GET`s answer what this node's _configuration_ says (`/ilp/identity`,
`/ilp/routes/price`, [ADR 0022](docs/adr/0022-a-connector-answers-it-does-not-announce.md)); a
counter is operational history and does not follow them onto the free side of that line. A public
dashboard therefore needs a server-side holder for the token, never a token in the browser and
never an open endpoint — see issue #669.

## Peer carriage

A peer rides one of the same two carriages a client speaks to, on `client_edge_addr` — there is no
second listener and no raw-TCP frame protocol; that was deleted with the old peer wire
([ADR 0027](docs/adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md)).
The peer endpoint's URL **scheme** picks the carriage — `wss://` for BTP (RFC-0023 frames),
`https://` for ILP-over-HTTP — and **role is decided by authentication**: an interaction is a
`peer` only if it presents a credential naming a peer id with a matching `[[peer_channels]]`
binding, never by which port or listener it arrived on. A claim rides the _next_ frame or request
to a peer after a fulfilment, not the PREPARE that caused it, and is signed as an EIP-712
`BalanceProof` ([ADR 0024](docs/adr/0024-peer-wire-claims-sign-the-eip-712-balance-proof.md)).

"Role is decided by authentication" says **which role you get**, not **whether you are let in**. An
interaction presenting no credential — every ordinary client — is admitted as a `client`, and so is
one whose credential does not satisfy both requirements. Neither is refused on the wire, because
refusing would make the check an oracle for the peer ids this node configures. What an operator
sees, though, depends on _which_ mistake was made:

- A credential naming a **configured** peer id that then fails P1 (wrong secret) or P2 (no
  `[[peer_channels]]` row) emits the rate-limited `peer_auth_refused` event
  ([`peer-carriage-spec.md`](docs/protocol/peer-carriage-spec.md) §1.6).
- A credential naming a peer id **no `[[peers]]` entry configures** emits **nothing at all**
  ([`decide_role`](crates/connector-peer-auth/src/decision.rs)'s branch table). Every ordinary
  client declares a `peerId` of its own on the same `auth` entry, so emitting there would fire on
  essentially every client session and hand any anonymous caller a log-volume lever.

The trap that falls out of it is worth memorising before you debug a peering: **a peer that
mistypes its `id` presents as an ordinary client with nothing logged, while a peer that mistypes
its `secret` is loud.** If the event you expect is missing entirely, check the id spelling on both
sides — see
[`docs/operators/btp-peer-transport-bringup.md`](docs/operators/btp-peer-transport-bringup.md).

The carriage mapping is specified in
[`docs/protocol/peer-carriage-spec.md`](docs/protocol/peer-carriage-spec.md). The semantics it
carries — claim exchange, flush, fees, minimum delivery, the refusal taxonomy — are
unchanged and still specified in [`docs/protocol/peer-wire-spec.md`](docs/protocol/peer-wire-spec.md)
§3–§6; that document's §1–§2 (the deleted raw-TCP frame protocol) no longer describes anything
this binary ships.

## Tests

The workspace gate, in the order CI runs it:

```bash
cargo fmt --all -- --check
cargo build --workspace
cargo test --workspace --exclude payment-channel
cargo clippy --workspace --exclude payment-channel --all-targets -- -D warnings
```

`make rust-build` and `make rust-test` are shorthands for the middle two. Fakes, not mocks
([ADR 0007](docs/adr/0007-testing-doctrine-fakes-yes-mocks-no.md)): a port is defined by one
contract suite that every implementation, real and fake, is run against.

Some integration tests need a real chain and **skip locally when it is absent, but panic when
`CI` is set** — so the gate can never go green without one:

| Needs                   | Get it with                                    | Tests                                                                                              |
| ----------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `anvil` (Foundry)       | `curl -L https://foundry.paradigm.xyz \| bash` | `connector-settlement-evm`, `connector-cli`, `connector-client-edge`, `connector-bin`              |
| `forge`                 | same                                           | `connector-settlement-evm`'s `abi_provenance` (rebuilds the contracts and diffs the committed ABI) |
| `solana-test-validator` | Solana CLI                                     | `connector-settlement-solana`                                                                      |

`make anvil-up` / `make solana-up` bring up the Docker profiles if you would rather not install
them. `packages/solana-program` is excluded from the workspace gate and has its own job
(`cargo test-sbf`).

## Where the design lives

| Path                                 | What it is                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`CONTEXT.md`](CONTEXT.md)           | The vocabulary every doc here uses — connector, app, handler, packet, route, claim, watermark, exposure, fee, price, probe. Read this first.                                                                                                                                                                      |
| [`docs/adr/`](docs/adr/)             | Numbered architecture decisions. Where an ADR and a spec disagree, the ADR wins.                                                                                                                                                                                                                                  |
| [`docs/protocol/`](docs/protocol/)   | The client-edge, peer-carriage and peer-semantics specs, and the invariants behind the vectors.                                                                                                                                                                                                                   |
| [`vectors/`](vectors/)               | `wire-vectors.json` — the cross-repo contract for `toon-client`, `rig` and `swap`. Generated, self-verified, and **normative**: prose is not ([ADR 0021](docs/adr/0021-vectors-are-normative-prose-is-not.md)). [`vectors/README.md`](vectors/README.md) documents it well enough to replay without reading Rust. |
| [`docs/operators/`](docs/operators/) | The prefix-retirement checklist, and closed records. Note that `admin-api.md`, `admin-api-inventory.md` and `load-testing-guide.md` document the **retired** TypeScript connector and are banner-marked as such.                                                                                                  |

Regenerate the vectors after any change to the envelope, the gift wrap, the fulfilment
derivation or the claim signing scheme:

```bash
cargo run -p connector-vectors --bin generate-vectors
```

## What else is in this repository

| Crate                                       | Role                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `connector-domain`                          | Pure logic, no I/O and no clock: packets, OER encoding, addresses, route selection, fee arithmetic, claim rules, the app envelope. |
| `connector-runtime`                         | The packet plane and its ports: the `Connector`, peer transport, claim book, leased routes, metrics.                               |
| `connector-signer`                          | The only crate that touches key material: the `Signer` port, gift wrap, claim-signature verification.                              |
| `connector-config`                          | The one typed config file and every refuse-to-start error it can raise.                                                            |
| `connector-btp`                             | The BTP frame codec and session framing (RFC-0023), transport-neutral — knows nothing about claims, routes or prices.              |
| `connector-peer-auth`                       | Role-by-authentication: whether an interaction is a peer or a client, decided from credential and config alone (ADR 0027).         |
| `connector-peer-btp`                        | The BTP peer carriage: dials and accepts peerings over `wss://`, atop `connector-btp`.                                             |
| `connector-peer-http`                       | The ILP-over-HTTP peer carriage: dials and accepts peerings over `https://`.                                                       |
| `connector-client-edge`                     | The client-edge router.                                                                                                            |
| `connector-operator`                        | The operator router.                                                                                                               |
| `connector-settlement`                      | The chain-agnostic settlement port and its contract suite.                                                                         |
| `connector-settlement-evm`                  | EVM backend against `TokenNetwork` via `TokenNetworkRegistry`.                                                                     |
| `connector-settlement-solana` (+`-program`) | Solana backend and the payment-channel program it drives.                                                                          |
| `connector-cli` / `connector-bin`           | Config loading, router assembly, and the `connector` and `stub-app` binaries.                                                      |
| `connector-vectors`                         | Generates `vectors/wire-vectors.json` from the real implementations.                                                               |

Beside the workspace, and not part of the connector:

- [`packages/contracts`](packages/contracts) — the Solidity (Foundry) `TokenNetwork` and
  `TokenNetworkRegistry` the EVM backend binds to.
- [`packages/solana-program`](packages/solana-program) — the legacy SPL-token payment-channel
  program.
- `packages/faucet`, `packages/mina-zkapp`, `packages/mina-usdc-faucet-web`, `tools/fund-peers` —
  devnet faucet tooling. These are the only reason npm, Jest and `package.json` are still here;
  `npm test` runs them, not the connector.
- [`packages/announcer`](packages/announcer) — a standalone `kind:10032` announcer sidecar for the
  client edge (ADR 0022: the connector answers, it does not announce, so this lives outside it).
- [`infra/`](infra) and [`deploy/`](deploy) — devnet overlays and deployment recipes.

## Devnet

The TOON devnet settles on public chains (Base Sepolia, Solana devnet, Mina devnet). Get test
funds from the [devnet faucet](https://faucet.devnet.toonprotocol.dev), and see the toon-client
rig README's
["Devnet reference (public chains)"](https://github.com/toon-protocol/toon-client/blob/main/packages/rig/README.md#devnet-reference-public-chains)
and [toon-meta `docs/deployment.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/deployment.md)
for current endpoints, contract addresses and token mints.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: the workspace gate above must pass, and a
change to a documented wire is a change to `vectors/wire-vectors.json` first.

## License

MIT — see [`LICENSE`](LICENSE).

## Links

- [Interledger Protocol](https://interledger.org)
- [RFC-0027 ILPv4](https://github.com/interledger/rfcs/blob/master/0027-interledger-protocol-4/0027-interledger-protocol-4.md)
- [RFC-0030 OER encoding](https://github.com/interledger/rfcs/blob/master/0030-notes-on-oer-encoding/0030-notes-on-oer-encoding.md)
