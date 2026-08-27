# Connector

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A paid reverse proxy.** You put it in front of an ordinary HTTP app, you set a
price, and it collects that price from whoever calls — in stablecoin, per
request, without your app knowing payment exists.

It does that by being an [Interledger](https://interledger.org) connector: value
arrives wrapped in a protocol your app never speaks, and at the last hop this
binary unwraps it, verifies it was paid for, and hands the app a plain HTTP
request. **It terminates payments the way nginx terminates SSL.**

The rest of this page is how to run one, in three steps — **run a node**, **put
your app behind it**, **get paid** — then peering, the operator surface, and
operating it. You do not need to know anything about Interledger. When you do
want that, [`docs/rfcs/`](docs/rfcs/README.md) is the protocol, the ten RFCs it
is built from, and where this connector departs from each.

---

## 1. Run a node

The connector is one static binary that reads one TOML file. Two ways to get it.

### With Docker

The published image is how this is meant to be deployed. It runs as uid `10001`
and creates `/app/state` owned by that uid, so a fresh named volume inherits the
ownership.

```bash
docker pull ghcr.io/toon-protocol/connector:rust-main
mkdir -p node/config node/data && cd node
openssl rand -hex 32 > data/signer.key && chmod 600 data/signer.key
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
      # A NAMED volume, not a bind mount. A host bind mount arrives root-owned
      # and the connector refuses to start.
      - connector-state:/app/state
    ports:
      # Loopback to begin with. The client edge is the paid surface; put a
      # TLS-terminating reverse proxy in front of it before it faces the world.
      - '127.0.0.1:3000:3000'
    restart: unless-stopped
    healthcheck:
      # Free and unauthenticated. Answering it means the config loaded, every
      # settlement backend connected, and the router is serving. `docker ps`
      # showing "Up" proves none of that.
      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/ilp/identity']
      interval: 10s
      timeout: 3s
      retries: 5

  quotes:
    image: your-quotes-app:latest
  search:
    image: your-search-app:latest

volumes:
  connector-state:
```

```bash
docker compose up -d
```

### From source

For changing the connector rather than running it. Rust stable, and clone with
submodules — `packages/contracts` vendors OpenZeppelin and forge-std:

```bash
git clone --recurse-submodules https://github.com/toon-protocol/connector.git
cd connector && cargo build --workspace
./target/debug/connector path/to/connector.toml
```

Paths in the config are then yours, not the image's: `state_dir = "./state"`,
`key_file = "./signer.key"`. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the test
gate and the chain binaries it needs.

### The config

```toml
client_edge_addr = "0.0.0.0:3000"
state_dir        = "/app/state"

[signer]
key_file = "/app/data/signer.key"   # 32 raw bytes, or 64 hex characters

# One route per thing you serve. Longest matching prefix wins, so a more
# specific prefix can sit beneath a broader one and take precedence.
[[routes]]
prefix      = "g.example.quotes"
handler_url = "http://quotes:8080/"
price       = 1000

[[routes]]
prefix      = "g.example.search"
handler_url = "http://search:8080/"
price       = 2500

# Same app, deeper prefix, different price. This wins over g.example.search
# for g.example.search.bulk because it matches more labels.
[[routes]]
prefix      = "g.example.search.bulk"
handler_url = "http://search:8080/bulk/"
price       = 10000
```

Then ask the node what it is:

```bash
curl http://localhost:3000/ilp
```

That free, unauthenticated `GET` returns the node's self-description — its
addresses, endpoints, identity key and settlement facts. A connector answers; it
never announces. It is also the whole of what another operator needs to peer with
you.

**Three things about the config that bite people:**

- **One TOML file, read once, immutable for the process lifetime.** There is no
  environment-variable layer — `CONFIG_FILE` and friends do nothing, and the only
  variable read is `RUST_LOG`. An unknown key is a hard load failure and a
  removed key is refused **by name**, so a stale config says so at boot instead
  of quietly doing nothing.
- **Every key is a path, never a value.** No inline keys, no mnemonic, nowhere to
  smuggle one through.
- **`state_dir` is where this node records which claims it has already been
  paid.** In a container it must be a mounted volume; a watermark that dies with
  the container hands every payer their spent claims back as free service.

## 2. Put your app behind it

A route with a `handler_url` **terminates** there. The connector opens the sealed
payload, makes exactly that HTTP request of your app, and seals the app's
complete response back.

**Your app is payment-oblivious, and that is the whole design.** It receives an
ordinary HTTP request. This connector adds no headers of any kind, holds no key
on the app's behalf, and the app supplies nothing toward the packet's fulfilment
— the connector derives that itself. So "the app answered" and "the packet was
paid for" stay separable, and an app that knows nothing about payment cannot
leak, forge or withhold one.

Two consequences before you price anything:

- **You are paid for an answer, not the answer the caller wanted.** A `404` from
  your app is a real answer: it rides home on a `FULFILL` and costs the same as a
  `200`. Only unreachability or a refused target produces a reject.
- **The trailing slash on `handler_url` is load-bearing**, and a request's target
  is resolved _beneath_ the handler's path — an absolute path, a `..` segment, a
  scheme or an authority is refused before your app is touched.

A terminated route **must** carry a `price`. Write `price = 0` if free is
deliberate, because it is never silently free.

## 3. Get paid

A price makes a route cost something. A **settlement backend** is what lets
anyone actually pay it.

```toml
[settlement.evm]
rpc_url          = "https://sepolia.base.org"
contract_address = "0x…"          # the TokenNetworkRegistry, not a TokenNetwork
token_address    = "0x…"
decimals         = 6

[settlement.evm.key]
key_file = "/app/data/settlement.key"
```

That is all of it. **You do not list the channels your payers will use, and you
could not** — a client's channel does not exist until that client opens it on
chain, long after your node booted. The settlement section does double duty: it
gives this node its on-chain identity, and it is where a claim naming a channel
you have never heard of is **resolved from chain** and accepted. That resolution
is what makes paying you permissionless rather than an arrangement.

> **Fund the settlement key _before_ you start the node**, and know that
> **booting a config is not a dry run**. A Solana backend submits a real
> transaction at `connect`; with no gas the connector exits 1 on a chain error
> that reads like a config bug. With a funded key, starting a node "just to see
> whether the TOML parses" spends real money.

You do not need to build the payer —
[`toon-client`](https://github.com/toon-protocol/toon-client) is that — but two
things help when debugging "why is nobody paying me". An ILP outcome is never an
HTTP one: a `FULFILL` and a `REJECT` both come back at HTTP **200**. And a caller
with no claim on a priced route gets **402** with an x402 document quoting the
same price a real request would be charged.

Claims are the truth; a balance is a projection of them. Turning them into money
on chain is the operator surface's job — the next section but one.

---

## Peering

Terminating your own routes earns from callers who know your address. Peering
puts you on paths that start somewhere else. It is one authenticated write:

```
POST /peers   { "id": "their-node", "url": "https://their-node.example",
                "fee": 100, "max_packet_amount": 1000000 }
```

The node fetches their self-description, picks the carriage from their endpoint's
scheme (`wss://` → BTP, `https://` → ILP-over-HTTP), finds the shared settlement
chain, and derives the channel from the two participants — no channel identifier
is ever exchanged, and there is no shared secret.

A route can then **forward** to that peering instead of terminating:

```toml
[[routes]]
prefix  = "g.partner"
peer_id = "their-node"
price   = 1500          # what a client pays you for the whole path
```

A route sets **exactly one** of `handler_url` or `peer_id`. A forwarding route
carries a `price` too — it is what the caller pays for the path — while the
`fee` you keep for your own hop lives on the peering, not the route.

Four things to know before you run it:

- **It can spend gas**, because it may open a channel and wait for confirmation.
  Safe to retry: the same request against an established peering finds the same
  channel rather than opening a second one.
- **`fee` and `max_packet_amount` are yours to choose.** No document can supply
  them — they are your policy about this counterparty.
- **A `502` is about them, a `400` is about you.** Unreachable, redirecting, or
  describing a node you cannot peer with is `502` — go look at the URL.
- **Their identity is trust-on-first-use over TLS, pinned by nothing.** You are
  trusting whoever answers that URL today.

Every `PREPARE` you forward carries its own covering claim, so nothing is ever
owed between packets — and equally, a hop can take your claim and decline to
carry. The bound on that is `max_packet_amount`, which is why it is yours to set.
The kill switch is `DELETE /peers/:id`.

---

## The operator surface

The control plane: how you inspect a running node and how you move its money.
(The retired TypeScript connector called this the "admin API" — that name, and
`docs/operators/admin-api.md`, describe a surface this binary does not have.)

It mounts **only** when `[operator]` is configured, and merges onto
`client_edge_addr` — there is no second port and no second listener.

```toml
[operator]
bearer_token_file = "/app/data/operator-bearer-token"
write_keys_file   = "/app/data/operator-write-keys"
```

Each setting is spelled as **exactly one of** a literal or a path:
`bearer_token` / `bearer_token_file`, `write_keys` / `write_keys_file`. The file
forms are the deployed forms, because a fleet's config files are committed to a
public repository and a literal cannot be.

### Read and write are different authorities

This is the whole design (ADR 0008), and the rules are numbered in
[`operator-spec.md`](docs/protocol/operator-spec.md):

- **Reads** take `Authorization: Bearer <token>` and nothing more.
- **Writes** take an RFC 9421 HTTP Message Signature from an ed25519 key on
  `write_keys`, with the body bound by an RFC 9530 `Content-Digest`.
- **A bearer token is never sufficient to move value** (OP-03). Read authority
  must not confer write authority.
- **Every write is attributable and individually revocable** (OP-02). A shared
  secret is neither: it cannot say which operator did a thing, and losing it
  loses everything at once.
- **An accepted write cannot be replayed** (OP-05). Signatures carry `created`
  and `expires`, and an accepted signature is remembered until its own expiry.
- **A surface with neither half authenticated refuses to start** (OP-04). An
  unauthenticated operator surface is worse than none, because it looks like a
  control plane.

`write_keys` holds only **public** halves. The private half lives with whoever is
calling and never on the node. `connector send --operator-key <file>
--print-keyid` prints the value that goes in the allowlist, derived by the binary
that will do the signing.

### Reads

| Endpoint             | Answers                                                   |
| -------------------- | --------------------------------------------------------- |
| `GET /peers`         | The peerings this node holds, config and runtime alike.   |
| `GET /routes`        | The full routing table, with each row's source.           |
| `GET /routes/leased` | TTL-bound pushed routes that lapse on their own.          |
| `GET /routes/peers`  | The durable runtime peer-route table.                     |
| `GET /channels`      | Every channel this node knows, with deposits and status.  |
| `GET /claims`        | The claim journal — what you have been paid, and by whom. |
| `GET /identity`      | This node's operator-facing identity.                     |
| `GET /audit-log`     | Every accepted write, with the key that made it.          |
| `GET /metrics`       | Prometheus text.                                          |

`/metrics` is a bearer-gated read like any other. There is **no** unauthenticated
metrics path and **no** health endpoint; absent `[operator]`, `/metrics` is not
mounted and answers 404 rather than 401. A public dashboard therefore needs a
server-side holder for the token — never a token in a browser.

The counters are `toon_packets_total`, `toon_packets_rejected_total`,
`toon_fees_earned_total`, `toon_settlement_total`, and `toon_exposure`, which is
always zero and kept only so scrape configs do not break.

### Writes

| Endpoint                               | Does                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `POST /packets`                        | Originate a packet from this node.                                        |
| `POST /peers`                          | Establish a peering from a URL. `DELETE /peers/:id` removes it.           |
| `POST /routes/peers`                   | Write a durable runtime route. `DELETE /routes/peers/:prefix` removes it. |
| `POST /routes/leased`                  | Push a TTL-bound route that lapses on its own.                            |
| `POST /channels`                       | Open a payment channel.                                                   |
| `POST /channels/:id/fund`              | **Self-deposit** — put your own collateral behind your own claims.        |
| `POST /channels/:id/redeem`            | Redeem a specific claim on chain.                                         |
| `POST /channels/:id/redeem-latest`     | Redeem the latest claim — **this is how you get paid**.                   |
| `POST /channels/:id/settle`            | Settle the channel.                                                       |
| `POST /channels/:id/close`             | Close it. `cooperative-close` is the agreed variant.                      |
| `POST /channels/:id/cooperative-close` | Close by agreement with the counterparty.                                 |

Channel operations answer **503** when no `[settlement]` backend is configured —
the node cannot reach a chain, and says so rather than pretending.

`POST`/`DELETE` on `/peers*` and `/routes/peers*` are the durable runtime table.
Unlike a leased route, they survive a restart — and they are **refused outright**,
never silently accepted as a shadow, when they would collide with a row the
config file already owns.

### Signing a write

The signature covers exactly three components — `@method`, `@path` and
`content-digest` — with `alg="ed25519"` and `keyid` set to the signer's own
ed25519 public key in hex. `connector send` is a worked example: it signs a
`POST /packets` this way, and `--expect-fulfill` makes a non-fulfilled packet a
non-zero exit, which is what turns a rehearsal into a gate.

---

## Operating it

**Logs** are structured JSON on stdout. Every line emitted while handling a
packet carries the same `correlation_id` — the packet's execution condition — and
because that value is invariant across hops, the same id appears in every
connector that handled it. `RUST_LOG=debug` for more.

**Releases.** `:rust-release` is a **promotion** tag, not a build output. A green
merge does not reach any box; the tag moves only by an explicit dispatch that
first checks the candidate image still boots the fleet's committed configs.
Because the binary and a box's mounted TOML are a matched pair in both
directions, **adding a required config key is a breaking deploy**: land the
config first, then move the tag.

**Devnet** settles on Base Sepolia and Solana devnet; test funds come from the
[devnet faucet](https://faucet.devnet.toonprotocol.dev). **Production is a named,
empty tier** — no machines, no mainnet contracts, no keys.

---

## Where to go next

| Path                                                                         | What it is                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`docs/rfcs/`](docs/rfcs/README.md)                                          | **The protocol.** Interledger, the ten vendored RFCs, and where TOON departs from each. |
| [`docs/operators/`](docs/operators/)                                         | Runbooks: peering bring-up, key rotation, fleet release.                                |
| [`docs/protocol/configuration-spec.md`](docs/protocol/configuration-spec.md) | Every config key, and what each one binds.                                              |
| [`deploy/connector-rust/README.md`](deploy/connector-rust/README.md)         | The container path in full, including a hand-built image.                               |
| [`local/`](local/README.md)                                                  | The shipped image against real chains — `make local-verify`.                            |
| [`CONTEXT.md`](CONTEXT.md)                                                   | The vocabulary. Read before writing docs or naming anything.                            |
| [`docs/adr/`](docs/adr/README.md)                                            | Why any of this is the way it is. The tiebreaker for everything.                        |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                         | Building from source, the test gate, the chain binaries it needs.                       |

## License

MIT — see [`LICENSE`](LICENSE). Except [`docs/rfcs/`](docs/rfcs/README.md), which
is CC BY-SA 4.0: it holds the Interledger Foundation's RFCs, reproduced
unmodified.
