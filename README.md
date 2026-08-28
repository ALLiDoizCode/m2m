# Connector

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A paid reverse proxy.** You put it in front of an ordinary HTTP app, you set a
price, and it collects that price from whoever calls — in tokens, per request,
without your app knowing payment exists.

It does that by being an [Interledger](https://interledger.org) connector: value
arrives wrapped in a protocol your app never speaks, and at the last hop this
binary unwraps it, verifies it was paid for, and hands the app a plain HTTP
request. **It terminates payments the way nginx terminates SSL.**

You do not need to know anything about Interledger to run one. This page is the
journey, in three steps:

|       | Step                                                | You end up with                                     |
| ----- | --------------------------------------------------- | --------------------------------------------------- |
| **1** | [Run a node](#1-run-a-node)                         | One binary, one config file, answering on a port.   |
| **2** | [Put your app behind it](#2-put-your-app-behind-it) | Your app served through it, unchanged.              |
| **3** | [Get paid](#3-get-paid)                             | A settlement chain, so anyone can pay what you ask. |

Then [peering](#peering), [the operator surface](#the-operator-surface) for
inspecting a node and moving its money, and [operating it](#operating-it) day to
day. When you do want the protocol, [`docs/rfcs/`](docs/rfcs/README.md) is the ten
RFCs it is built from and where this connector departs from each.

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

> [!NOTE]
> **The published image is `linux/amd64` only.** On Apple Silicon (or any other
> arm64 host), pull and run it under emulation:
>
> ```bash
> docker pull --platform linux/amd64 ghcr.io/toon-protocol/connector:rust-main
> ```
>
> and add `platform: linux/amd64` next to `image:` on the `connector` service in
> `compose.yml` below.

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
#
# `price` is a whole number of the SMALLEST UNIT of the token you settle in
# (step 3) — the way a card terminal counts in cents, never in dollars. How
# many of those units make one token is the token's `decimals`. USDC has 6,
# so 1,000,000 units are one USDC, and:
#
#     price = 1000        0.001 USDC   a tenth of a cent
#     price = 100000      0.10  USDC   ten cents
#     price = 1000000     1.00  USDC   one dollar
#
# A wallet or a dashboard shows the whole-token figure. This file never does.
[[routes]]
prefix      = "g.example.quotes"
handler_url = "http://quotes:8080/"
price       = 1000                       # 0.001 USDC per request

[[routes]]
prefix      = "g.example.search"
handler_url = "http://search:8080/"
price       = 2500                       # 0.0025 USDC

# Same app, deeper prefix, different price. This wins over g.example.search
# for g.example.search.bulk because it matches more labels.
[[routes]]
prefix      = "g.example.search.bulk"
handler_url = "http://search:8080/bulk/"
price       = 10000                      # 0.01 USDC, a cent

# If your app's own costs go up with the size of what it is handed — storage,
# uploads, anything you pay an upstream by the byte for — price it by size
# instead of picking one number and losing money at one end of the range:
#
#     base     what every request pays, whatever it carries
#     per_kib  added for each started kibibyte of the request's payload
#
# A caller is charged `base + per_kib × ceil(payload_size / 1024)`, and both
# figures are published, so it can work out what a request costs before
# sending it. Leave `price` a plain number when one number is right — that is
# still what most routes want.
[[routes]]
prefix      = "g.example.store"
handler_url = "http://store:8080/"
price       = { base = 1000, per_kib = 30 }   # 0.001 USDC + 0.00003 per KiB
```

Then ask the node what it is:

```bash
curl http://localhost:3000/ilp
```

That free, unauthenticated `GET` returns the node's self-description — its
addresses, endpoints, identity key and settlement facts. A connector answers; it
never announces. It is also the whole of what another operator needs to peer with
you, once [`[node]` and `peer_expose`](#being-peerable) are set — this minimal
config's own self-description has no endpoints and nothing to dial.

> [!IMPORTANT]
> **Three things about the config that bite people.**
>
> - **One TOML file, read once, immutable for the process lifetime.** There is
>   no environment-variable layer — `CONFIG_FILE` and friends do nothing, and the
>   only variable read is `RUST_LOG`. An unknown key is a hard load failure and a
>   removed key is refused **by name**, so a stale config says so at boot instead
>   of quietly doing nothing.
> - **Every key is a path, never a value.** No inline keys, no mnemonic, nowhere
>   to smuggle one through.
> - **`state_dir` is where this node records which claims it has already been
>   paid.** In a container it must be a mounted volume; a watermark that dies
>   with the container hands every payer their spent claims back as free
>   service.

## 2. Put your app behind it

A route with a `handler_url` **terminates** there. The connector opens the sealed
payload, makes exactly that HTTP request of your app, and seals the app's
complete response back.

**Your app is payment-oblivious, and that is the whole design.** It receives an
ordinary HTTP request. It holds no key on your behalf, and it supplies nothing
toward the packet's fulfilment — the connector derives that itself. So "the app
answered" and "the packet was paid for" stay separable, and an app that knows
nothing about payment cannot leak, forge or withhold one.

The one thing this connector does add is attribution, on a request it took the
payment for itself: `X-TOON-Payer` (the paying channel), `X-TOON-Amount` (what
that request was charged) and `X-TOON-Chain`. Your app is free to ignore all
three — it is handed them so it can log or rate-limit by payer if it wants to,
not so it can decide anything about the payment. They are absent on a request
this node did not take the payment for, so treat them as optional. Whatever a
caller writes under those names is stripped before your app sees it.

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
anyone actually pay it. There are two chains. A node may carry either table or
both — with both, it accepts claims on both at once.

```toml
# EVM — Base Sepolia. These are live addresses, not placeholders.
[settlement.evm]
rpc_url          = "https://base-sepolia-rpc.publicnode.com"
contract_address = "0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5"  # the TokenNetworkRegistry, not a TokenNetwork
token_address    = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"  # the token every price on this node is in
decimals         = 6              # units per token: 6 means 1,000,000 = 1.00

[settlement.evm.key]
key_file = "/app/data/settlement.key"

# Solana — public devnet. Note `program_id` where EVM has `contract_address`:
# there is no registry to resolve a channel contract through, so this names the
# payment-channel program itself, and `token_address` is an SPL mint.
[settlement.solana]
rpc_url       = "https://api.devnet.solana.com"
program_id    = "2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip"
token_address = "34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU"
decimals      = 6

[settlement.solana.key]
key_file = "/app/data/settlement-solana.key"
```

Those are the addresses the devnet fleet itself runs on, and copying them is the
point rather than a shortcut: a claim resolves against **one** deployment, so
every node that might accept a given claim has to name the same one.

|                  | EVM                                                                                                                                                      | Solana                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain            | Base Sepolia, chain id `84532`                                                                                                                           | public devnet (`solana:devnet`)                                                                                                                                                 |
| RPC              | `https://base-sepolia-rpc.publicnode.com`                                                                                                                | `https://api.devnet.solana.com`                                                                                                                                                 |
| Channels live in | [`0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5`](https://sepolia.basescan.org/address/0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5) — `TokenNetworkRegistry` | [`2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip`](https://explorer.solana.com/address/2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip?cluster=devnet) — the payment-channel program |
| Token            | [`0x49beE1Bca5d15Fb0963117923403F9498119a9Ce`](https://sepolia.basescan.org/address/0x49beE1Bca5d15Fb0963117923403F9498119a9Ce) — mock USDC, 6 dp        | [`34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU`](https://explorer.solana.com/address/34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU?cluster=devnet) — mock USDC mint, 6 dp        |
| Funding the key  | Base Sepolia ETH for gas; mock USDC from the [devnet faucet](https://faucet.devnet.toonprotocol.dev)                                                     | devnet SOL (`solana airdrop 1 <address> -u devnet`); mock USDC from the same faucet                                                                                             |
| Full record      | [`packages/contracts/deployments/base-sepolia.md`](packages/contracts/deployments/base-sepolia.md)                                                       | [`packages/solana-program/deployments/devnet-public.md`](packages/solana-program/deployments/devnet-public.md)                                                                  |

**That table is the whole list, and the omissions are deliberate.** There is no
Solana _testnet_ deployment — the program is on devnet and nowhere else — and
there is no mainnet on either chain. No EVM mainnet carries a `TokenNetwork` or a
token for a registry to resolve, so `contract_address` has nothing to point at;
and because a Solana claim's signed message binds the settlement program, a node
pointing `[settlement.solana]` at a mainnet RPC while naming the devnet program
id would take money for claims it can never redeem. Production is a **named,
empty tier** ([ADR 0056](docs/adr/0056-production-is-a-named-empty-tier.md)), and
[`connector.production.toml`](deploy/connector-rust/connector.production.toml) is
a skeleton in which every value fails to load on purpose. Do not fill it in.

`decimals` is what turns a `price` into money. Every `price` in the config is a
count of the token's smallest unit, and `decimals` says how many of those make
one whole token — so with `decimals = 6`, `price = 1000` is 0.001 of the token,
and a route meant to cost ten cents of USDC is `price = 100000`. The node reads
the token's own decimals at boot and **refuses to start** if the config
disagrees, because a wrong `decimals` is not a rounding error: it misprices
every route by a factor of ten or more.

That check is one of several, and they are why there is no `--network` flag and
no environment variable anywhere in this: which chain a node is on **is** these
values and nothing else, so every one of them is verified against the chain
before the node serves a packet. The EVM backend reads the chain id off the RPC
and calls `getTokenNetwork()` to prove the address really is a registry; the
Solana backend proves `program_id` is executable _and_ behaves like the
payment-channel program, that `token_address` is an SPL mint, and asks the chain
its own genesis hash so a claim declaring the wrong cluster is refused. A node
that boots is a node whose chain agreed with its config.

That is all of it. **You do not list the channels your payers will use, and you
could not** — a client's channel does not exist until that client opens it on
chain, long after your node booted. The settlement section does double duty: it
gives this node its on-chain identity, and it is where a claim naming a channel
you have never heard of is **resolved from chain** and accepted. That resolution
is what makes paying you permissionless rather than an arrangement.

> [!WARNING]
> **Fund the settlement key _before_ you start the node**, and know that
> **booting a config is not a dry run**. A Solana backend submits a real
> transaction at `connect`; with no gas the connector exits 1 on a chain error
> that reads like a config bug. With a funded key, starting a node "just to see
> whether the TOML parses" spends real money.

You do not need to build the payer —
[`toon-client`](https://github.com/toon-protocol/toon-client) is that — but two
things help when debugging "why is nobody paying me":

- **An ILP outcome is never an HTTP one.** A `FULFILL` and a `REJECT` both come
  back at HTTP **200**.
- **A caller with no claim on a priced route gets `402`**, with an x402 document
  quoting the same price a real request would be charged.

Claims are the truth; a balance is a projection of them. Turning them into money
on chain is [the operator surface](#the-operator-surface)'s job.

---

## Peering

Terminating your own routes earns from callers who know your address. Peering
puts you on paths that start somewhere else.

### Being peerable

Step 1's config boots and serves, but nobody can peer _with_ it: its
self-description has no endpoints and `"peerCarriages": []`, so a
counterparty's `POST /peers` at it answers `502`. Three more keys, none of
them shown above, close that gap:

```toml
# Top level, so it goes above every table — beside step 1's client_edge_addr.
peer_expose = "http"             # "btp", "http", "both", or "neither" (default)

[node]
addresses     = ["g.your.node"]
http_endpoint = "https://your-node.example/ilp"
```

`peer_expose` says which carriage(s) _this_ node opens a peer listener for.
`[node]` publishes where clients reach it — both listeners are served
whatever `peer_expose` says, so publishing either endpoint is always allowed.
What `peer_expose` decides is what you may _omit_: `btp_endpoint` is required
only when `"btp"` or `"both"` is exposed, and `http_endpoint` is required
whenever anything is exposed, because a peer pays you by asking your client
edge over HTTP whichever carriage its packets ride. So an HTTP-only node
writes `http_endpoint` and simply leaves `btp_endpoint` out; a BTP node writes
both; and with `"neither"` (the default) a `[node]` naming only `addresses` is
legal and still answers `GET /ilp`, it is just not dialable.

For a local or pre-TLS trial only, add `peer_allow_plaintext_endpoints = true`
at the top level so `http://`/`ws://` endpoints are accepted too — every
deployed config should stay on `https://`/`wss://`.

With that in place, `GET /ilp` really is the whole of what another operator
needs to peer with you. It is one authenticated write:

```
POST /peers   { "id": "their-node", "url": "https://their-node.example/ilp",
                "fee": 100, "max_packet_amount": 1000000 }
```

`url` is their connector's self-description URL — the one whose `GET` answers
with that description (ADR 0050) — not their origin. The node fetches it, picks
the carriage from their endpoint's scheme (`wss://` → BTP, `https://` →
ILP-over-HTTP), finds the shared settlement chain, and derives the channel from
the two participants — no channel identifier is ever exchanged, and there is no
shared secret.

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

> [!NOTE]
> **Four things to know before you run it.**
>
> - **It can spend gas**, because it may open a channel and wait for
>   confirmation. Safe to retry: the same request against an established
>   peering finds the same channel rather than opening a second one.
> - **`fee` and `max_packet_amount` are yours to choose.** No document can
>   supply them — they are your policy about this counterparty.
> - **A `502` is about them, a `400` is about you.** Unreachable, redirecting,
>   or describing a node you cannot peer with is `502` — go look at the URL.
> - **Their identity is trust-on-first-use over TLS, pinned by nothing.** You
>   are trusting whoever answers that URL today.

### A route is a path, not a destination

Every `PREPARE` you forward carries its own covering claim, so nothing is ever
owed between packets — and equally, a hop can take your claim and decline to
carry. That is not a defect to be engineered away; it is the shape of the
protocol, and payment channels exist precisely so that it costs you almost
nothing. Once a packet leaves you, its value is signed away: a fulfilment is a
delivery receipt, not a payment trigger, and a `REJECT` (an `F02` for a name
nobody routes, a `T01` for a peer that was not there) comes back with your
claim already spent. What the channel buys you is that this can only ever
happen to **one packet** — the last one in flight. Nobody holds your deposit;
every hop holds only what you have already signed to it, and the most the next
hop can walk away with is the one packet you just handed it.

So the risk of a hop is not something you check, it is something you **size**.
Keep packets small — a relay write is 1 micro-USDC, a store upload is priced
per kibibyte, and "large volumes of low-value packets" is what ILPv4 is designed
for (RFC 0027; RFC 0018 calls the small packet the default risk mitigation).
Then let the amount grow with the route's record: a path that has fulfilled a
thousand packets has earned a bigger one, a path you opened this morning has
not. `max_packet_amount` is the same number seen from the other side — the
largest single packet you will carry _for_ a peer, which is the most that peer
can cost you at once — and it is yours to choose for the same reason.

That is why this section is called peering and not addressing. A destination
is just a prefix; what you actually commit money to is the **path** the packet
takes to it — the hops between you and the prefix, each one a peering someone
chose, each one taking its fee and each one a place the packet can stop. The
relay in this fleet does not "send to the store"; it forwards
`g.toon.relay.store` across the one peering it holds with the store, on the
one channel it funded, at the one cap it set. Two paths to the same prefix
are two different things to trust, and a well-trodden one is worth more than
a short one. The kill switch for a path you have stopped trusting is
`DELETE /peers/:id`.

Hop count is worth thinking about the same way. Fees add up per hop; exposure
does not. You hand your packet to the first hop and that hop is your only
counterparty — what happens further down is the next hop's business, on the
next hop's channel, under its own cap — so a packet that dies anywhere costs
you the one packet you sent, whether it died at the second hop or the tenth.
Ten well-walked hops therefore beat two with a stranger in them: the extra
hops cost a few micro-USDC in fees, and the stranger can cost you the whole
packet. Longer roads also tend to run through nodes that peer widely, which
have another way onward when one leg goes dark.

The long version of this — why Glinda says _follow the yellow brick road_
rather than giving Dorothy an address — is
[`docs/the-yellow-brick-road.md`](docs/the-yellow-brick-road.md).

---

## The operator surface

The control plane: how you inspect a running node and how you move its money.

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
mounted and answers 404 rather than 401. A _public_ status page — one strangers
load — therefore needs a server-side holder for the token, never the token
embedded in the page. Your own browser session is different, and that is what
the dashboard below is.

The counters are `toon_packets_total`, `toon_packets_rejected_total`,
`toon_fees_earned_total`, `toon_settlement_total`, and `toon_exposure`, which is
always zero and kept only so scrape configs do not break.

### The dashboard

`GET /dashboard` is the operator's own view of all of the above on one page the
node serves (ADR 0066): packet traffic and rejects by code, fees earned, inbound
and outbound claims, peerings and channels, every route with its source, and
the audit log. It needs no token to load, because it holds nothing. Paste the
bearer token in and it reads; paste an operator key in and it can peer, write a
runtime route or lease one, signing each write in your browser exactly as
`connector send` would. The key stays in the tab's memory — never stored, never
sent — and config-file rows are shown with no button, because a price or a fee
still changes by editing the file and restarting. Reach the page the way you
reach `/metrics` on that box: on the fleet, an SSH tunnel to `client_edge_addr`.

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

For every other write — `POST /peers` above all —
[`docs/operators/sign-write.sh`](docs/operators/sign-write.sh) is a shell-and-`openssl` signer with
a worked example in [`docs/operators/signing-a-write.md`](docs/operators/signing-a-write.md).

---

## Operating it

**Logs** are structured JSON on stdout. Every line emitted while handling a
packet carries the same `correlation_id` — the packet's execution condition — and
because that value is invariant across hops, the same id appears in every
connector that handled it. `RUST_LOG=debug` for more.

**Releases.** A release is one dispatch of `release-connector.yml`: it builds the
image, cuts a dated handle and opens a GitHub Release. It does not deploy, and
nothing here moves a tag onto a box (ADR 0068) — a node repository pins the
connector image it runs, by release handle, in its own `deploy/` bundle. Because
the binary and a box's mounted TOML are a matched pair in both directions,
**adding a required config key is a breaking deploy**: land the config first, then
bump that pin.

**Devnet** settles on Base Sepolia and Solana devnet; test funds come from the
[devnet faucet](https://faucet.devnet.toonprotocol.dev). **Production is a named,
empty tier** — no machines, no mainnet contracts, no keys.

---

## Where to go next

| Path                                                                         | What it is                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`docs/the-yellow-brick-road.md`](docs/the-yellow-brick-road.md)             | **The idea.** Why you pay a path and not a destination, and why the road earns the traffic. |
| [`docs/rfcs/`](docs/rfcs/README.md)                                          | **The protocol.** Interledger, the ten vendored RFCs, and where TOON departs from each.     |
| [`docs/protocol/configuration-spec.md`](docs/protocol/configuration-spec.md) | Every config key, and what each one binds.                                                  |
| [`docs/protocol/operator-spec.md`](docs/protocol/operator-spec.md)           | The operator surface's rules, numbered.                                                     |
| [`docs/operators/`](docs/operators/)                                         | Runbooks: peering bring-up, key rotation, fleet release and health.                         |
| [`deploy/connector-rust/README.md`](deploy/connector-rust/README.md)         | The container path in full, including a hand-built image.                                   |
| [`local/`](local/README.md)                                                  | The shipped image against real chains — `make local-verify`.                                |
| [`CONTEXT.md`](CONTEXT.md)                                                   | The vocabulary. Read before writing docs or naming anything.                                |
| [`docs/adr/`](docs/adr/README.md)                                            | Why any of this is the way it is. The tiebreaker for everything.                            |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                         | Building from source, the test gate, the chain binaries it needs.                           |

## License

MIT — see [`LICENSE`](LICENSE). Except [`docs/rfcs/`](docs/rfcs/README.md), which
is CC BY-SA 4.0: it holds the Interledger Foundation's RFCs, reproduced
unmodified.
