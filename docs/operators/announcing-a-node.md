# Announcing a node

`connector announce` publishes one kind:10032 `IlpPeerInfo` event describing this node, to a relay
you choose, **from the node being announced**, paid for through that node's own routing like any
other write.

It is a one-shot operator action. A serving connector announces nothing on its own — see
[ADR 0030](../adr/0030-an-operator-announces-a-node-the-node-still-does-not.md) for why the verb
belongs to you and not to the daemon.

```
connector announce --config /app/config/connector.toml https://relay-op.example/ilp
```

| argument | meaning |
| --- | --- |
| `--config <path>` | this node's config file. **Never positional here**, so a config file called `announce` can never be mistaken for the subcommand. |
| `<relay-discovery-url>` | **the node you pay.** The client-edge ILP endpoint of the connector that fronts the relay you want to be discovered on. Its x402 greeting quotes the price and names the EIP-712 domain your claim is signed under; its `/ilp/identity` is the key the packet is sealed to; and the paid packet is POSTed straight back to it. |
| `--to <ilp-address>` | the ILP address to publish to. Defaults to `[announce] publish_to`. |
| `--target <path>` | the write ingress's path **beneath** the route's own `handler_url`. Defaults to `""`, "the route's own handler path", which is right whenever that `handler_url` already ends at the ingress (`http://relay:3100/write`). |
| `--via-own-routing` | send the packet through **your own routing table** instead of paying the URL. See "Routing it yourself" below. |
| `--dry-run` | negotiate, build and sign, print, and stop. Nothing is paid and nothing is sent. Safe beside a running node. |

## The URL is where you pay

By default the announce is **paid to the URL you gave**, as an ordinary client of that node: the
encoded PREPARE is POSTed to it with a payment-channel claim in the `ilp-payment-channel-claim`
header, exactly as any buyer's write is. Your own routing table is not consulted, so you need:

- **no `[[routes]]` entry** reaching that relay,
- **no peering** to originate over,

only a funded channel with the node you are paying. That is what makes this work from a node like
the devnet store box, whose peering is accept-only and which serves no `g.toon.relay` route.

### Where the claim comes from — and why there is no second key

| what | where it comes from | why it cannot come from anywhere else |
| --- | --- | --- |
| signing key | `[settlement.evm]` | the channel's on-chain participant **is** this node's settlement address — the same key ADR 0024's outbound peer claims are signed with |
| EIP-712 domain | the **target's** x402 greeting (`extra.settlement`) | its claim gate recovers the signer under the domain **it** resolved for the channel; signing under yours recovers a different address |
| nonce, cumulative amount | the target's `POST /ilp/claim-state` | the **receiver** is the authority on its own watermark — a nonce that does not advance it is refused as a replay, and a guessed one either replays or silently overpays |
| channel id | `[announce] pay_channel` | the only fact neither side can derive |

`pay_channel` is deliberately **not** a `[[client_channels]]` row. That table is channels this node
*receives* on ("whose signature I accept"); this is a channel it *pays* from. Putting one channel in
both roles is the same namespace collision `Config::load` already refuses between the peer and client
books.

Open the channel however you normally would — the target's `POST /channels`, or any TOON client —
then name its 32-byte on-chain id here. The target does not need to have heard of you: an
unaffiliated buyer's channel resolves from chain (issue #502).

## Routing it yourself

`--via-own-routing` sends the packet through this node's own routing table instead — the same
`Connector::handle_prepare` call `POST /packets` makes. It is a coherent thing to want (it pays over
an existing peering rather than a client channel), but it is the opt-in rather than the default
because it makes the URL argument mean two things at once: who you *ask* and, only if your routing
table happens to reach them, who you *pay*.

It needs what the client path does not: a `[[routes]]` entry reaching the relay's connector, and — over
a peering — the ability to originate on it. It also adds this hop's own `fee` to the amount, since
the terminating side charges its own price on arrival (ADR 0028, #754).

Start with `--dry-run`. It prints the exact event, so you can read what you are about to broadcast,
and it quotes what it would cost.

## The `[announce]` section

Only the facts a node genuinely **cannot introspect about itself** live here. Everything else in the
announce comes from the running configuration: prices from `[[routes]]`, settlement contracts from
the `[settlement.*]` tables the node verified against a chain at startup, the edge identity from
`[signer]`.

```toml
[announce]
addresses     = ["g.toon.ario"]          # primary first; required
http_endpoint = "https://proxy.ario.devnet.toonprotocol.dev/ilp"
btp_endpoint  = "wss://proxy.ario.devnet.toonprotocol.dev/ilp/btp"
# relay_url   = "wss://relay.devnet.toonprotocol.dev"  # ONLY if this node fronts a relay
# publish_to  = "g.toon.relay"           # default for `--to`
# pay_channel = "0x…"                    # the channel this node PAYS from (32-byte on-chain id)
# route_publish / route_store            # override the `.relay`/`.store` suffix heuristic
# asset_code = "USDC"                    # default
# asset_scale = 6                        # default
# solana_chain_id = "solana:devnet"      # default; qualifies the greeting's bare "solana"
# ttl_secs = 600                         # default; NIP-40 expiration
```

### Three URLs, and conflating any two is the bug

| | what it is | where it comes from |
| --- | --- | --- |
| **through** | the edge you publish **through** — pay here | the CLI argument |
| **`http_endpoint` / `btp_endpoint`** | where clients **pay you** | this section |
| **`relay_url`** | where clients **read you for free** | this section, and **optional** |

`relay_url` is **not** derivable from the through-URL, and must not be inferred from it: the relay
you publish *through* need not be the relay you advertise for *reads*. They coincide on the devnet
apex, and that coincidence is exactly what would make an inferred value look correct until it wasn't.

Nor is it derivable from `[[routes]]`. `g.toon.relay`'s `handler_url` is `http://relay:3100/write` —
the relay's **private write ingress on a container network**, which is neither public nor a read
surface. An `http(s)://` `relay_url` is refused at config load for that reason: announcing it would
publish an unauthenticated write door to every client on the network.

**Omit `relay_url` when this node fronts no relay.** The devnet store box fronts none. Its announce
should say so by leaving the field out, not by pointing at the apex's relay and claiming reads it
does not serve.

### The destination is not negotiated

The through-URL's x402 greeting carries the price and the settlement terms, but **not** the address
to publish to: `payTo` echoes back whichever destination the asking PREPARE named. So `--to` (or
`[announce] publish_to`) is required, and an invocation with neither is refused rather than guessed.

If you discovered the relay from another node's kind:10032 announce, the address you want is that
announce's own `routes.publish`.

## What the node needs before this can work

1. **A funded channel with the node you are paying**, named in `[announce] pay_channel`.
2. **A `[settlement.evm]` table** — the claim is signed by the channel's on-chain participant, which
   is this node's settlement identity. There is no second key.
3. **A `key_file` identity.** A Nostr signature is BIP-340 Schnorr over the event's own id, which
   needs the scalar itself — a KMS-held `[signer]` cannot announce.
4. **A target whose route accepts HTTP.** A route pinned to `transport = "btp"` (issue #701) answers
   a *paid* request with the same x402 terms it answers an unpaid one, so the client path cannot pay
   it. This is refused up front, before anything is signed. **The devnet apex pins `g.toon.relay` to
   `transport = "btp"` today**, so announcing to it over HTTP needs that policy widened first.

With `--via-own-routing`, replace (1) and (2) with: a `[[routes]]` entry reaching the relay's
connector, and a channel with whoever carries it (over a peering, the `[[peer_channels]]` row it
already needs). (4) does not apply — the client-edge transport policy applies to clients.

## When it refuses to run beside a serving node

A node's outbound peer-claim ledger is replayed from `state_dir`'s journal at startup and held in
memory, and the journal has no lock. Two processes over one `state_dir` both resume at nonce N, both
sign N+1 against different cumulative amounts, and the counterparty refuses one as a replay — after
which the serving node's claims never advance the far side's watermark again and the peering
silently stops being paid.

An outbound **peer** claim is signed when a packet is forwarded over a peering, and nowhere else. So
this applies to `--via-own-routing` only, and refuses exactly when all three hold:

1. the config names a `state_dir`;
2. the destination resolves to a **`peer_id` route** — the announce would forward; and
3. something is already listening on this config's `client_edge_addr`.

The **default client path is never blocked**, and does not need to be: it signs a *client* claim by
hand against a channel whose watermark authority is the receiver (asked over `POST /ilp/claim-state`,
never remembered locally), and it never touches `ClientPayoutLedger` — so there is no local mutable
money state to fork. Announcing to a route this node *terminates* is likewise unblocked, and so is
`--dry-run`.

When it does refuse: stop the node, announce, start it again — or drop `--via-own-routing`.

> **Why `--via-own-routing` cannot help a node like the store box.** On a node whose only peering is
> **accept-only** — no `endpoint`, the far side dials in — a second process cannot originate over
> that peering at all: the accepted session belongs to the serving process, and this one gets an
> empty transport and `T01 peer unreachable`. That is the devnet store box's shape, and it is
> exactly why the client path is the default: paying the URL needs no peering and no route.

## Reading the failures

| what you see | what to change |
| --- | --- |
| `requires the 'btp' transport` | that route is pinned `transport = "btp"` (issue #701) and the client path pays over HTTP. Widen the route's policy, or use `--via-own-routing` over a peering. |
| `no [announce] pay_channel` | open a funded channel with the node you are paying and name its on-chain id. |
| `would not report this node's claim state` | that node cannot resolve the channel, or its counterparty is not this node's settlement address. |
| `spendable headroom … but the announce costs` | fund the channel. Nothing was sent. |
| `F02 no route to destination` | `--via-own-routing` only: this node has no `[[routes]]` entry reaching the destination. |
| `F03` | the amount did not cover what the terminating side charges on arrival (ADR 0028's subtraction — this hop forwards `amount - fee`). Raise the forwarded route's `price`, or lower its `fee`. |
| `F01 gift wrap could not be opened` | the through-URL **forwards** the destination onwards rather than terminating it, so the wrap was sealed to a hop. Point `--to` at a route that terminates where the through-URL is. |
| `T01 peer unreachable` | the route's next hop is a peering this process cannot dial. |
| `answered ... instead of 402 x402 terms` | that edge serves no route for the destination you asked about. |
| `the packet FULFILLed ... but the relay's write ingress answered HTTP 4xx` | the money is spent; the relay refused the event. Check `--target`, and that the ingress wants `{"event": ...}`. |
