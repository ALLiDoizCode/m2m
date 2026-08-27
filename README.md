# Connector

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A paid reverse proxy.** You put it in front of an ordinary HTTP app, you set a
price, and it collects that price from whoever calls — in stablecoin, per
request, without your app knowing payment exists.

It does that by being an [Interledger](https://interledger.org) connector: value
arrives wrapped in a protocol your app never speaks, and at the last hop this
binary unwraps it, verifies it was paid for, and hands the app a plain HTTP
request. **It terminates payments the way nginx terminates SSL.**

The rest of this page is how to run one. You need Docker and about ten minutes;
you do not need to know anything about Interledger. When you do want that,
[`docs/rfcs/`](docs/rfcs/README.md) is the protocol, the ten RFCs it is built
from, and where this connector departs from each.

---

## 1. Run a node

```bash
docker pull ghcr.io/toon-protocol/connector:rust-main
```

Pin an exact `rust-sha-<short>` tag for anything you care about; `rust-main`
moves. Three files: a config, a key, a compose file.

```bash
mkdir -p node/config node/data && cd node
openssl rand -hex 32 > data/signer.key && chmod 600 data/signer.key
```

`config/connector.toml`:

```toml
client_edge_addr = "0.0.0.0:3000"
state_dir        = "/app/state"

[signer]
key_file = "/app/data/signer.key"   # 32 raw bytes, or 64 hex characters

[[routes]]
prefix      = "g.example.app"
handler_url = "http://app:3100/"
price       = 0                     # free on purpose — priced in stage 3
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
      # A NAMED volume, not a bind mount. The image runs as uid 10001 and creates
      # /app/state, so a fresh named volume inherits that ownership. A host bind
      # mount arrives root-owned and the connector refuses to start.
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

  app:
    image: your-app:latest # anything that answers HTTP — stage 2

volumes:
  connector-state:
```

```bash
docker compose up -d
curl http://localhost:3000/ilp        # the node's self-description
```

That free, unauthenticated `GET` is how a node answers "what are you" — its
addresses, endpoints, identity key and settlement facts. A connector answers; it
never announces. It is also the whole of what another operator needs to peer with
you in stage 4.

**Three things about the config that bite people:**

- **One TOML file, read once, immutable for the process lifetime.** There is no
  environment-variable layer — `CONFIG_FILE` and friends do nothing, and the only
  variable read is `RUST_LOG`. An unknown key is a hard load failure and a
  removed key is refused **by name**, so a stale config tells you at boot instead
  of quietly doing nothing.
- **Every key is a path, never a value.** No inline keys, no mnemonic, nowhere to
  smuggle one through.
- **`state_dir` must be a mounted volume.** It is where this node writes down
  which claims it has already been paid. A watermark that dies with the container
  hands every payer their spent claims back as free service.

## 2. Put your app behind it

A route with a `handler_url` **terminates** there. The connector opens the sealed
payload, makes exactly that HTTP request of your app, and seals the app's
complete response back.

```toml
[[routes]]
prefix      = "g.example.app"
handler_url = "http://your-app:8080/"
price       = 1000
```

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

Two things turn a serving node into an earning one: **a price**, and **a
settlement backend**.

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

Then watch it arrive:

```bash
curl -H "Authorization: Bearer $TOKEN" https://your-node/claims
curl -X POST … https://your-node/channels/<id>/redeem-latest
```

Claims are the truth; a balance is a projection of them. Each supersedes the last
on its channel, so redeeming means taking the **latest** to the chain. That is a
**write**, so it needs an RFC 9421 signature from a key on `[operator]
write_keys`, not the bearer token — no shared secret is ever sufficient to move
value. There is no threshold and no netting cycle: settlement is something you do
on purpose.

You do not need to build the payer —
[`toon-client`](https://github.com/toon-protocol/toon-client) is that — but two
things help when debugging "why is nobody paying me". An ILP outcome is never an
HTTP one: a `FULFILL` and a `REJECT` both come back at HTTP **200**. And a caller
with no claim on a priced route gets **402** with an x402 document quoting the
same price a real request would be charged.

## 4. Peer

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

Four things to know before you run it:

- **It can spend gas**, because it may open a channel and wait for confirmation.
  Safe to retry: the same request against an established peering finds the same
  channel rather than opening a second one.
- **`fee` and `max_packet_amount` are yours to choose.** No document can supply
  them — they are your policy about this counterparty. The fee is flat, per
  packet, and attaches to the peering rather than to a route.
- **A `502` is about them, a `400` is about you.** Unreachable, redirecting, or
  describing a node you cannot peer with is `502` — go look at the URL.
- **Their identity is trust-on-first-use over TLS, pinned by nothing.** You are
  trusting whoever answers that URL today.

Every `PREPARE` you forward carries its own covering claim, so nothing is ever
owed between packets — and equally, a hop can take your claim and decline to
carry. The bound on that is `max_packet_amount`, which is why it is yours to set.
The kill switch is `DELETE /peers/:id`.

## 5. Operate it

**Logs** are structured JSON on stdout. Every line emitted while handling a
packet carries the same `correlation_id` — the packet's execution condition — and
because that value is invariant across hops, the same id appears in every
connector that handled it. `RUST_LOG=debug` for more.

**The operator surface** mounts only when `[operator]` is configured, and merges
onto `client_edge_addr` — there is no second port. Reads take a bearer token
(`/peers`, `/routes`, `/channels`, `/claims`, `/metrics`). Writes take an RFC
9421 signature from a key on `write_keys`; the private half never lives on the
node. There is no health endpoint and no unauthenticated metrics path.

**Releases.** `:rust-release` is a **promotion** tag, not a build output. A green
merge does not reach any box; the tag moves only by an explicit dispatch that
first checks the candidate image still boots the fleet's committed configs.
Because the binary and a box's mounted TOML are a matched pair in both
directions, **adding a required config key is a breaking deploy**: land the
config first, then move the tag.

**Devnet** settles on Base Sepolia and Solana devnet; test funds come from the
[devnet faucet](https://faucet.devnet.toonprotocol.dev). **Production is a named,
empty tier** — no machines, no mainnet contracts, no keys.

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
