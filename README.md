# Connector

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A paid reverse proxy.** You put it in front of an ordinary HTTP app, you set a
price, and it collects that price from whoever calls — in stablecoin, per
request, without your app knowing payment exists.

It does that by being an [Interledger](https://interledger.org) connector: value
arrives wrapped in a protocol your app never speaks, and at the last hop this
binary unwraps it, verifies it was paid for, and hands the app a plain HTTP
request. **It terminates payments the way nginx terminates SSL.**

This guide takes you from nothing to a node that earns. Each stage works on its
own; stop after stage 5 and you have an app being paid for by strangers.

| Stage                                                  | You end up with                                   |
| ------------------------------------------------------ | ------------------------------------------------- |
| [1. The protocol](#1-the-protocol)                     | Enough Interledger to read the rest               |
| [2. Run a node](#2-run-a-node)                         | A connector serving a packet, locally             |
| [3. Put your app behind it](#3-put-your-app-behind-it) | Your own HTTP service on a route                  |
| [4. Get paid](#4-get-paid)                             | A price, claims arriving, money redeemed on chain |
| [5. Peer](#5-peer)                                     | Traffic from other operators' networks            |
| [6. Operate it](#6-operate-it)                         | Logs, metrics, releases                           |
| [7. Go deeper](#7-go-deeper)                           | The specs, the records, the vectors               |

---

## 1. The protocol

A payment travels as a **packet**. A sender builds a `PREPARE` carrying an
amount, an expiry, a 32-byte execution condition and an opaque `data` payload,
addressed to an ILP address like `g.example.app`. Each **connector** along the
way looks up the longest matching prefix in its routing table and either
forwards the packet to a **peer** or **terminates** it — meaning the address
belongs to an app it serves. The terminating connector answers with a `FULFILL`
carrying the preimage of that condition, or a `REJECT` carrying a code. That
answer travels back along the same path.

What each hop keeps is a flat **fee**; what the caller pays for the whole path
is a flat **price**. Money does not move inside the packet: each hop is backed
by a payment channel, and a packet carries a signed **claim** on that channel —
an off-chain IOU whose cumulative total only ever rises. Settling means taking
the latest claim to the chain and redeeming it. That is rare and deliberate;
the claims are the fast path.

Ten RFCs specify this, and this repository **vendors all ten** under
[`docs/rfcs/`](docs/rfcs/README.md) — the upstream text, unmodified and pinned,
under a **TOON profile** that says exactly where this connector departs and
which record governs the departure
([ADR 0062](docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)).
Read the profile before the body; they often disagree, and the profile is where
you find out why.

| RFC                                                                                                         | What it gives you                        | Where TOON departs                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001 Architecture](docs/rfcs/0001-interledger-architecture/0001-interledger-architecture.md)               | The layered model, the hop-by-hop shape  | Two of its five layers are absent: no transport layer, no ledger abstraction                                                                                                  |
| [0015 ILP Addresses](docs/rfcs/0015-ilp-addresses/0015-ilp-addresses.md)                                    | `g.example.app`, longest-prefix matching | Addresses are self-asserted; allocation schemes (`peer.`, `self.`, `private.`) have no behaviour here                                                                         |
| [0018 Risk Mitigations](docs/rfcs/0018-connector-risk-mitigations/0018-connector-risk-mitigations.md)       | The risks of running a forwarding node   | Exposure limits are deleted, not reduced; one per-packet cap replaces them                                                                                                    |
| [0019 Glossary](docs/rfcs/0019-glossary/0019-glossary.md)                                                   | The field's vocabulary                   | [`CONTEXT.md`](CONTEXT.md) is this repo's vocabulary and wins; "ledger", "transfer" and "receiver" are gone                                                                   |
| [0023 BTP](docs/rfcs/0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md)                  | The `wss://` carriage                    | The frame grammar is the deployed client's dialect; the `auth` frame authenticates nothing                                                                                    |
| [0027 ILPv4](docs/rfcs/0027-interledger-protocol-4/0027-interledger-protocol-4.md)                          | The packet: PREPARE, FULFILL, REJECT     | ⚠ **The wire encoding is TOON's, not this RFC's** ([ADR 0063](docs/adr/0063-the-ilp-packet-is-toons-dialect-not-rfc-0027s.md)); `data` is sealed to the terminating connector |
| [0030 OER Encoding](docs/rfcs/0030-notes-on-oer-encoding/0030-notes-on-oer-encoding.md)                     | How a packet becomes bytes               | Stricter: length determinants must be canonical, trailing bytes are refused                                                                                                   |
| [0032 Peering & Settlement](docs/rfcs/0032-peering-clearing-settlement/0032-peering-clearing-settlement.md) | What a peering is for                    | Clearing is per packet. No balance, no threshold, no netting cycle, no credit limit                                                                                           |
| [0034 Connector Requirements](docs/rfcs/0034-connector-requirements/0034-connector-requirements.md)         | The job of the thing you are running     | No route discovery, no advertisement, no exchange rates, no quoting                                                                                                           |
| [0035 ILP over HTTP](docs/rfcs/0035-ilp-over-http/0035-ilp-over-http.md)                                    | The `https://` carriage, `POST /ilp`     | Adds the claim header, the `402` payment-required document, and an anonymous-by-default caller                                                                                |

**Read the 0027 row twice.** This connector has **ILPv4 semantics and TOON's own
encoding**, and "speaks ILPv4" is retired as a description of it
([ADR 0063](docs/adr/0063-the-ilp-packet-is-toons-dialect-not-rfc-0027s.md)). The
packet's meanings are RFC 0027's — the three types, the field order, `condition
= sha256(fulfilment)`, the `F`/`T`/`R` codes — but its bytes are not, and will
not decode in a conforming ILPv4 implementation. That is deliberate, not a bug
to fix: four other things would stop a standard sender from paying a node here
even with perfect bytes, so the encoding is the _last_ obstacle to
interoperation rather than the first. The bytes are pinned in
[`vectors/wire-vectors.json`](vectors/README.md#the-ilp-packet-encoding), which
walks them one at a time for anyone writing an encoder.

**What TOON does not use, and why.** If you know Interledger, these are the
absences to notice — each is deliberate, and none is vendored:

- **SPSP (0009)** — no payment-setup handshake. A payer reads a free `GET` on the
  node's URL and `GET /ilp/routes/price`.
- **STREAM (0029)** and **STREAM receipts (0039)** — no transport layer at all.
  One sealed request envelope per packet; no chunking, no flow control.
- **Payment pointers (0026)** — a route is an ILP address, a node is a URL.
- **HTLA (0022)** — no ledger-layer trust spectrum. Every peering is backed by a
  payment channel and authorised by a signed claim.
- **ILDCP (0031)** — the connector neither discovers nor advertises. Configuration
  is one TOML file; a peering is an operator write.
- **Settlement engines (0038)** — settlement is in-process, not a sidecar.
- **Relationship between protocols (0033)** — the map it draws is not this stack.

---

## 2. Run a node

**Run it as a container.** The connector is one static binary that reads one
TOML file, and the published image is how it is meant to be deployed — it runs
as uid `10001`, creates `/app/state` owned by that uid, and carries no runtime
of its own.

```bash
docker pull ghcr.io/toon-protocol/connector:rust-main
```

Pin an exact `rust-sha-<short>` tag for anything you care about; `rust-main`
moves. A third tag, `rust-release`, is a **promotion** tag and not a build
output — see stage 6.

### A node, start to finish

Three files: a config, a key, a compose file.

```bash
mkdir -p node/config node/data && cd node
openssl rand -hex 32 > data/signer.key && chmod 600 data/signer.key
```

`config/connector.toml` — the smallest file that serves:

```toml
client_edge_addr = "0.0.0.0:3000"

# Where this node writes down which claims it has already been paid.
# Read stage 4 before you leave this out.
state_dir = "/app/state"

[signer]
key_file = "/app/data/signer.key"   # 32 raw bytes, or 64 hex characters

[[routes]]
prefix      = "g.example.app"
handler_url = "http://app:3100/"
price       = 0                     # free, on purpose — priced in stage 4
```

`compose.yml`:

```yaml
services:
  connector:
    image: ghcr.io/toon-protocol/connector:rust-main
    command: ['/app/config/connector.toml']
    volumes:
      - ./config/connector.toml:/app/config/connector.toml:ro
      - ./data:/app/data:ro
      # A NAMED volume, not a bind mount. The image creates /app/state owned by
      # uid 10001, so a fresh named volume inherits that ownership. A host bind
      # mount arrives root-owned and the connector refuses to start.
      - connector-state:/app/state
    ports:
      # Loopback only to begin with. The client edge is the paid surface; put a
      # TLS-terminating reverse proxy in front of it before it faces the world.
      - '127.0.0.1:3000:3000'
    restart: unless-stopped
    healthcheck:
      # Free and unauthenticated, and answering it means the config loaded, every
      # configured settlement backend connected, and the router is serving.
      # `docker ps` showing "Up" proves none of that.
      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/ilp/identity']
      interval: 10s
      timeout: 3s
      retries: 5

  app:
    image: your-app:latest # anything that answers HTTP — stage 3

volumes:
  connector-state:
```

```bash
docker compose up -d
docker compose logs -f connector
```

Three things about this file are load-bearing, and each is a real failure people
hit:

- **`/app/state` is a named volume.** A watermark that dies with the container is
  the same defect one indirection down. A host bind mount arrives root-owned and
  the node refuses to start; `chown 10001:10001` it first if you must use one.
- **Keys are mounted read-only, and by path.** Key material is referenced by
  location, never by value
  ([ADR 0009](docs/adr/0009-one-typed-config-file-no-environment-layer.md),
  [ADR 0012](docs/adr/0012-a-signer-and-a-treasury-not-a-wallet.md)). There is no
  environment-variable layer to smuggle one through, and no mnemonic anywhere in
  this binary.
- **The healthcheck asks the node a question.** `GET /ilp/identity` is free and
  unauthenticated. A container that is "Up" but refused its config is a container
  that answers nothing.

### Build it instead

Only if you are changing the connector. Rust stable, and clone with submodules
because `packages/contracts` vendors OpenZeppelin and forge-std:

```bash
git clone --recurse-submodules https://github.com/toon-protocol/connector.git
cd connector && cargo build --workspace   # target/debug/connector
connector path/to/connector.toml
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the test gate and the chain binaries it
needs.

### Prove it moves a packet

The compose file above serves, but it does not prove value moves. `local/` does:
it runs this same image against real containerised chains, provisions the keys
and channels, and sends a real packet through it.

```bash
make local-up        # build the image, start anvil + solana, provision, run
make local-rehearse  # send a real packet; non-zero unless it is fulfilled
make local-down      # stop it, and remove the state volumes with it
```

`make local-verify` is all three, and is what CI runs on three topologies
(`solo` by default, plus `two-hop` and `mixed-chain` via `LOCAL_TOPOLOGY=`).
[`local/README.md`](local/README.md) is the long version.

What you just ran was a `POST /packets` to the node's operator surface, signed
with an ed25519 key, which formed an OER `PREPARE` gift-wrapped to the
terminating connector, and got a `FULFILL` back. `connector send` is the
operator tool that does it; `--expect-fulfill` is what makes it a gate rather
than a report.

### Ask the node what it is

```bash
curl http://localhost:3000/ilp
```

A free, unauthenticated `GET` on the client edge returns the node's
**self-description**: its addresses, endpoints, identity key and settlement
facts. A connector answers; it never announces
([ADR 0022](docs/adr/0022-a-connector-answers-it-does-not-announce.md),
[ADR 0050](docs/adr/0050-a-connectors-url-resolves-to-its-self-description.md)).
This is also how another operator peers with you in stage 5 — the URL is the
whole of what they need.

### About that config file

One typed TOML file, read once at boot, fully validated, immutable for the
process lifetime. There is **no environment-variable override layer**
([ADR 0009](docs/adr/0009-one-typed-config-file-no-environment-layer.md)) —
`CONFIG_FILE` and friends do nothing, and the only variable read is `RUST_LOG`.
An unknown key is a hard load failure, and a removed key is refused **by name**
rather than ignored — a config that named a key we retired tells you so at boot
instead of quietly doing nothing.

There is one consequence worth planning around: because the binary and the file
are a matched pair in both directions, **adding a required key is a breaking
deploy**. Land the config first, then move the image.

[`docs/protocol/configuration-spec.md`](docs/protocol/configuration-spec.md) is
the full key reference, and
[`deploy/connector-rust/README.md`](deploy/connector-rust/README.md) is the
container path end to end.

> **Two things that will surprise you**, both from the only third-party
> bring-up ([#1098](https://github.com/toon-protocol/connector/issues/1098)):
>
> - **Fund the settlement key _before_ you configure the backend.** A Solana
>   backend does not merely validate at boot — it sends
>   `create_associated_token_account_idempotent` and simulates an
>   `InitializeChannel`. With no SOL the connector **exits 1** on a chain error,
>   which reads like a config bug and is not.
> - **Booting a config is not a dry run.** With a funded key present, starting a
>   node "just to see whether the TOML parses" sends real transactions and
>   spends real gas.

---

## 3. Put your app behind it

A route with a `handler_url` **terminates** there. The connector opens the
sealed payload, makes exactly that HTTP request of your app, and seals the app's
complete response back.

```toml
[[routes]]
prefix      = "g.example.app"
handler_url = "http://your-app:8080/"
price       = 1000
```

In `local/solo` this is `stub-app`, the image's second binary. Point
`handler_url` at your own service instead and you have replaced it.

**Your app is payment-oblivious, and that is the whole design.** It receives an
ordinary HTTP request. This connector adds no `TOON-Fulfillment` header, no
`X-TOON-Payer`, no headers of any kind. It holds no key, signs nothing, and
supplies nothing toward the packet's fulfilment — the terminating connector
derives that itself from the sealed request
([ADR 0019](docs/adr/0019-a-terminating-connector-derives-the-fulfilment.md)).
So "the app answered" and "the packet was paid for" stay separable, and an app
that knows nothing about payment cannot leak, forge or withhold one.

Two consequences worth knowing before you price anything:

- **You are paid for an answer, not for the answer the caller wanted.** A `404`
  from your app is a real answer: it rides home on a `FULFILL` and costs the
  same as a `200` (`packet-flow-spec.md` **PF-23**). Only unreachability or a
  refused target produces a reject.
- **The trailing slash on `handler_url` is load-bearing**, and so is the
  confinement rule: a request's target is resolved _beneath_ the handler's path,
  and an absolute path, a `..` segment, a scheme or an authority is refused
  before your app is touched
  ([ADR 0025](docs/adr/0025-an-envelope-target-is-confined-beneath-the-handler-path.md)).

A terminated route **must** carry a `price` — write `price = 0` if free is
deliberate, because it is never silently free.

---

## 4. Get paid

Two things turn a serving node into an earning one: **a price**, and **a
settlement backend**. Add the whole of it to the config from stage 2:

```toml
state_dir = "/app/state"          # read the warning below

[[routes]]
prefix      = "g.example.app"
handler_url = "http://your-app:8080/"
price       = 1000                # base units of the settlement token

[settlement.evm]
rpc_url          = "https://sepolia.base.org"
contract_address = "0x…"          # the TokenNetworkRegistry, not a TokenNetwork
token_address    = "0x…"
decimals         = 6

[settlement.evm.key]
key_file = "/app/data/settlement.key"
```

That is the whole of it. **You do not list the channels your payers will use,
and you could not** — a client's channel does not exist until that client opens
it on chain, which happens long after your node booted. The settlement section
is doing double duty: it gives this node its on-chain identity, and it is also
where a claim naming a channel you have never heard of gets **resolved from
chain** and accepted
([ADR 0052](docs/adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md),
`configuration-spec.md` **CF-27**). That resolution is what makes paying you
permissionless rather than an arrangement.

`[[client_channels]]` exists, and this guide leaves it out on purpose. It
**declares** a channel and its counterparty key up front, and a declared channel
is answered from memory with no chain read at all. It is an optimisation for a
counterparty you already know — not a registry, not a gate, and never something
you can fill in ahead of your first customer. A node with an empty one is not a
node that refuses payment.

> ⚠ **Set `state_dir` even though the parser will not make you.** Config load
> only demands it when a channel _book_ is configured — and the permissionless
> shape above has no book, so this file loads with watermarks held in process
> memory alone. Every restart then reads every spent nonce as fresh, and every
> claim a payer has already spent buys service again. Nothing in a log shows
> that it did. Tracked as
> [#1186](https://github.com/toon-protocol/connector/issues/1186); until it is
> fixed, the config is trusting you to remember.

In a container `state_dir` must be a **mounted volume** — the named volume in
stage 2's compose file, not a path in the writable layer.

`decimals` is a **declaration, not a conversion**. Nothing scales by it — every
amount on the value path is already in the token's base units. Startup reads the
token's own `decimals()` and refuses to boot if the two disagree.

### What a payer meets

You do not need to build the client — [`toon-client`](https://github.com/toon-protocol/toon-client)
is that — but you need to recognise these when debugging "why is nobody paying
me":

1. They `GET` your URL for the self-description, and
   `GET /ilp/routes/price?destination=g.example.app` for the price. Both are
   free, and the price is the same lookup a real request is charged against, so
   it can never quote a price you would not also charge.
2. They `POST /ilp` an OER `PREPARE` — in TOON's encoding, not RFC 0027's byte
   layout ([ADR 0063](docs/adr/0063-the-ilp-packet-is-toons-dialect-not-rfc-0027s.md)),
   which is why an off-the-shelf ILPv4 client is not the thing you debug
   against. **An ILP outcome is never an HTTP one** — a `FULFILL` and a
   `REJECT` both come back at HTTP **200**.
3. With no claim on a route you both terminate and price, they get **402** and
   an x402 `PaymentRequired` document quoting that price.
4. They retry with a signed claim in `ILP-Payment-Channel-Claim`. It is checked
   structure → freshness against the watermark → value against the price →
   signature, in that order, so a replay or an underpayment never costs you a
   signature verification. A failing claim rejects the packet before it reaches
   your app: `F03` for underpayment, `F01` for the rest.

**No registration is required to pay you.** A caller presenting no identity is
anonymous, which is a first-class path, not a fallback: an unaffiliated buyer
pays for a route without ever meeting the operator
([ADR 0052](docs/adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md)).
What authorises a write is the claim, never a session or a token
([ADR 0008](docs/adr/0008-operator-surface-splits-read-from-write.md)).

One thing a claim can never do is vouch for itself. A signature is checked
against the counterparty this node resolved for that channel — declared or read
from chain — and never against the signer the claim declares. "Unverifiable" is
never "accepted": an unreachable RPC endpoint refuses the claim it was asked
about, distinguishably, rather than letting it through.

### Turning claims into money

```bash
curl -H "Authorization: Bearer $TOKEN" https://your-node/claims
curl -H "Authorization: Bearer $TOKEN" https://your-node/channels
```

Claims are the truth; a balance is a projection of the journal
([ADR 0005](docs/adr/0005-claims-are-truth-balances-are-a-projection.md)). Each
one supersedes the last on its channel, so redeeming means taking the **latest**
to the chain:

```
POST /channels/:id/redeem-latest
```

That is a **write**, so it needs an RFC 9421 signature from a key on
`[operator] write_keys`, not the bearer token — no shared secret is ever
sufficient to move value. There is no threshold, no trigger and no netting
cycle: settlement is something you do, on purpose, when you want the money on
chain.

The rehearsal in stage 2 proves a packet moves. It does **not** prove you get
paid — `connector send` holds no channel and signs no claim. `GET /claims`
growing is the thing that proves it.

---

## 5. Peer

Terminating your own routes earns from callers who know your address. Peering
puts you on paths that start somewhere else.

Since [ADR 0058](docs/adr/0058-a-peering-is-established-from-a-url.md) that is
one authenticated write against a URL:

```
POST /peers   { "id": "their-node", "url": "https://their-node.example",
                "fee": 100, "max_packet_amount": 1000000 }
```

The node fetches their self-description, picks the carriage from their
endpoint's scheme (`wss://` → BTP, `https://` → ILP-over-HTTP), finds the shared
settlement chain, and derives the channel from the two participants
([ADR 0059](docs/adr/0059-a-channel-is-derived-from-its-participants.md)) — no
channel identifier is ever exchanged. It answers with which branch it took,
`channel: { id, status: "found" | "created" }`.

Four things to know before you run it:

- **It can spend gas**, because it may open a channel and wait for confirmation.
  It is safe to retry: the same request against an established peering finds the
  same channel rather than opening a second one.
- **`fee` and `max_packet_amount` are yours to choose.** No document can supply
  them — they are your policy about this counterparty
  ([ADR 0006](docs/adr/0006-the-connector-is-mechanism-not-policy.md)). The fee
  is flat, per packet, and attaches to the **peering**, not to a route
  ([ADR 0061](docs/adr/0061-a-fee-attaches-to-a-peering-not-to-a-route.md)).
- **A `502` is about them, a `400` is about you.** Unreachable, redirecting,
  oversized, or describing a node you cannot peer with is `502` — go look at the
  URL. `400` is yours to fix.
- **Their identity is trust-on-first-use over TLS, pinned by nothing.** You are
  trusting whoever answers that URL today. Worth knowing before you peer with a
  stranger.

There is no shared secret. Peer role is proved per frame by a channel binding
plus a claim signature
([ADR 0060](docs/adr/0060-a-claim-proves-a-peering-and-the-shared-secret-is-deleted.md)),
and the kill switch is `DELETE /peers/:id`.

Every `PREPARE` you forward carries its own covering claim
([ADR 0042](docs/adr/0042-a-packet-carries-its-claim.md)), so nothing is ever
owed between packets — and equally, a hop can take your claim and decline to
carry. The bound on that is `max_packet_amount`, which is why it is your policy
and not theirs.

`make local-verify LOCAL_TOPOLOGY=two-hop` rehearses a real peering end to end.

---

## 6. Operate it

**Logs** are structured JSON on stdout, one object per line. Every line emitted
while handling a packet carries the same `correlation_id` — the packet's
execution condition, hex-encoded — and because that value is invariant across
hops, the same id appears in every connector that handled the packet
([ADR 0014](docs/adr/0014-metrics-surface-and-packet-correlated-logs.md)).
`RUST_LOG=debug` for more.

**The operator surface** mounts only when `[operator]` is configured, and it
merges onto `client_edge_addr` — there is no second port. It splits read from
write:

- **Reads** need `Authorization: Bearer <token>`: `GET /peers`, `/routes`,
  `/channels`, `/claims`, `/identity`, `/audit-log`, `/metrics`.
- **Writes** need an RFC 9421 HTTP Message Signature from an ed25519 key on
  `write_keys`, with the body bound by a `Content-Digest`: `POST /packets`,
  `/peers`, `/channels`, `/channels/:id/{fund,redeem,redeem-latest,close,cooperative-close}`,
  and `DELETE /peers/:id`.

The private half of a write key never lives on the node — `write_keys` holds
only public halves. `connector send --operator-key <file> --print-keyid` answers "what value goes in this
node's `write_keys`" from the binary that will do the signing.

**Metrics** are `toon_packets_total`, `toon_packets_rejected_total`,
`toon_fees_earned_total`, `toon_settlement_total`, and `toon_exposure` (always
zero — kept only so scrape configs do not break,
[ADR 0033](docs/adr/0033-the-exposure-machinery-is-retired-not-restated.md)).
There is **no health endpoint** and **no unauthenticated metrics path**; absent
`[operator]`, `/metrics` is not mounted and answers 404 rather than 401. A public
dashboard therefore needs a server-side holder for the token, never a token in
the browser.

**Releases.** `:rust-release` is a **promotion tag**, not a build output. A green
merge does not reach any box; the tag moves only by an explicit dispatch that
first checks the candidate image still boots the fleet's committed configs
([ADR 0041](docs/adr/0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md)).
Releases are named by a monotonic handle (`2026.08.21.1`), never semver
([ADR 0055](docs/adr/0055-a-release-is-one-dispatch-and-the-ordering-rides-as-data.md)).

Because the binary and a box's mounted TOML are a matched pair in both
directions, **adding a required config key is a breaking deploy**: land the
config first, then move the tag.

**Devnet** settles on public chains — Base Sepolia and Solana devnet. Test funds
come from the [devnet faucet](https://faucet.devnet.toonprotocol.dev); current
endpoints, contract addresses and token mints are in
[toon-meta `docs/deployment.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/deployment.md).

**Production is a named, empty tier** ([ADR 0056](docs/adr/0056-production-is-a-named-empty-tier.md)):
no machines, no mainnet contracts, no keys. Its one artefact is a skeleton in
which every value is invalid on purpose, and a test fails the build if anyone
fills it in. It is blocked on deployments, not on configuration.

---

## 7. Go deeper

| Path                                                                   | What it is                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`CONTEXT.md`](CONTEXT.md)                                             | The vocabulary. Read before writing docs or naming anything.                                                                                       |
| [`docs/adr/`](docs/adr/README.md)                                      | The numbered decisions. Where an ADR and a spec disagree, the ADR wins.                                                                            |
| [`docs/rfcs/`](docs/rfcs/README.md)                                    | The ten vendored Interledger RFCs and their TOON profiles. CC BY-SA 4.0, not MIT.                                                                  |
| [`docs/protocol/`](docs/protocol/)                                     | The configuration, client-edge, peer-carriage, packet-flow and payment specs.                                                                      |
| [`vectors/`](vectors/README.md)                                        | `wire-vectors.json` — generated, self-verifying and **normative**. Prose is not ([ADR 0021](docs/adr/0021-vectors-are-normative-prose-is-not.md)). |
| [`docs/operators/`](docs/operators/)                                   | Runbooks. `admin-api.md` and `load-testing-guide.md` describe the retired TypeScript connector.                                                    |
| [`docs/architecture/source-tree.md`](docs/architecture/source-tree.md) | The repository map: every crate, and what is deliberately not the connector.                                                                       |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                   | The workspace gate, the chain binaries the tests need, and the testing doctrine.                                                                   |

The order of authority, when two of these disagree:

```
vectors  >  ADRs  >  docs/protocol/ specs  >  a TOON profile  >  an RFC body
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: the workspace gate must
pass, and a change to a documented wire is a change to
`vectors/wire-vectors.json` first.

## License

MIT — see [`LICENSE`](LICENSE). Except [`docs/rfcs/`](docs/rfcs/README.md),
which is CC BY-SA 4.0: it holds the Interledger Foundation's RFCs, reproduced
unmodified.
