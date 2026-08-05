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
| `<relay-discovery-url>` | the **through-URL**: the client-edge ILP endpoint of the connector that fronts the relay you want to be discovered on. Its x402 greeting quotes the price; its `/ilp/identity` is the key the packet is sealed to. |
| `--to <ilp-address>` | the ILP address to publish to. Defaults to `[announce] publish_to`. |
| `--target <path>` | the write ingress's path **beneath** the route's own `handler_url`. Defaults to `""`, "the route's own handler path", which is right whenever that `handler_url` already ends at the ingress (`http://relay:3100/write`). |
| `--dry-run` | negotiate, build and sign, print, and stop. Nothing is paid and nothing is sent. Safe beside a running node. |

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

1. **A route to the destination.** The announce is paid through this node's own routing, so a
   `[[routes]]` entry must reach the connector fronting the chosen relay — terminating locally (a
   node that fronts its own relay) or forwarding over a peering. Without one the packet comes home
   `F02 no route to destination`.
2. **A channel with whoever carries it.** Over a peering, that is the `[[peer_channels]]` row the
   peering already needs. For a stranger's node, `POST /channels` opens one.
3. **A `key_file` identity.** A Nostr signature is BIP-340 Schnorr over the event's own id, which
   needs the scalar itself — a KMS-held `[signer]` cannot announce.

## When it refuses to run beside a serving node

A node's outbound peer-claim ledger is replayed from `state_dir`'s journal at startup and held in
memory, and the journal has no lock. Two processes over one `state_dir` both resume at nonce N, both
sign N+1 against different cumulative amounts, and the counterparty refuses one as a replay — after
which the serving node's claims never advance the far side's watermark again and the peering
silently stops being paid.

An outbound claim is signed when a packet is **forwarded over a peering**, and nowhere else. So
`connector announce` refuses exactly when all three hold:

1. the config names a `state_dir`;
2. the destination resolves to a **`peer_id` route** — the announce would forward; and
3. something is already listening on this config's `client_edge_addr`.

Announcing to a route this node **terminates** — the apex publishing to its own relay, which is the
common case — writes no journal entry and is not blocked. Neither is `--dry-run`, which signs
nothing for the wire and sends nothing.

When it does refuse: stop the node, announce, start it again.

> **Known gap (issue #784).** On a node whose only peering is **accept-only** — no `endpoint`, the
> far side dials in, which is the devnet store box's shape — a second process cannot originate over
> that peering at all: the accepted session belongs to the serving process. Such a node cannot
> announce itself with this subcommand today. See ADR 0030's consequences.

## Reading the failures

| what you see | what to change |
| --- | --- |
| `F02 no route to destination` | this node has no `[[routes]]` entry reaching the destination. |
| `F03` | the amount did not cover what the terminating side charges on arrival (ADR 0028's subtraction — this hop forwards `amount - fee`). Raise the forwarded route's `price`, or lower its `fee`. |
| `F01 gift wrap could not be opened` | the through-URL **forwards** the destination onwards rather than terminating it, so the wrap was sealed to a hop. Point `--to` at a route that terminates where the through-URL is. |
| `T01 peer unreachable` | the route's next hop is a peering this process cannot dial. |
| `answered ... instead of 402 x402 terms` | that edge serves no route for the destination you asked about. |
| `the packet FULFILLed ... but the relay's write ingress answered HTTP 4xx` | the money is spent; the relay refused the event. Check `--target`, and that the ingress wants `{"event": ...}`. |
