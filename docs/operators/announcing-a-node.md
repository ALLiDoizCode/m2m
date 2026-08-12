# Announcing a node

`connector announce` publishes one kind:10032 `IlpPeerInfo` event describing this node, to a relay
you choose, **from the node being announced**, **paying that relay's connector like any other
client**.

It is a one-shot operator action. A serving connector announces nothing on its own — see
[ADR 0030](../adr/0030-an-operator-announces-a-node-the-node-still-does-not.md) for why the verb
belongs to you and not to the daemon.

```
connector announce --config /app/config/connector.toml https://relay-op.example/ilp
```

| argument                | meaning                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--config <path>`       | this node's config file. **Never positional here**, so a config file called `announce` can never be mistaken for the subcommand.                                                                                                                                                                                               |
| `<relay-discovery-url>` | **the node you pay.** The client-edge ILP endpoint of the connector that fronts the relay you want to be discovered on. Its x402 greeting quotes the price and names the EIP-712 domain your claim is signed under; its `/ilp/identity` is the key the packet is sealed to; and the paid packet is POSTed straight back to it. |
| `--to <ilp-address>`    | the ILP address to publish to. Defaults to `[announce] publish_to`.                                                                                                                                                                                                                                                            |
| `--btp-url <wss-url>`   | the target's **BTP** endpoint, used when its route requires that carriage. Defaults to `[announce] publish_btp_url`. **Never derived** — see below.                                                                                                                                                                            |
| `--target <path>`       | the write ingress's path **beneath** the route's own `handler_url`. Defaults to `""`, "the route's own handler path", which is right whenever that `handler_url` already ends at the ingress (`http://relay:3100/write`).                                                                                                      |
| `--via-own-routing`     | send the packet through **your own routing table** instead of paying the URL. See "Routing it yourself" below.                                                                                                                                                                                                                 |
| `--dry-run`             | negotiate, build and sign, print, and stop. Nothing is paid and nothing is sent. Safe beside a running node.                                                                                                                                                                                                                   |

## The URL is where you pay

By default the announce is **paid to the URL you gave**, as an ordinary client of that node: the
encoded PREPARE is POSTed to it with a payment-channel claim in the `ilp-payment-channel-claim`
header, exactly as any buyer's write is. Your own routing table is not consulted, so you need:

- **no `[[routes]]` entry** reaching that relay,
- **no peering** to originate over,

only a funded channel with the node you are paying. That is what makes this work from a node like
the devnet store box, whose peering is accept-only and which serves no `g.toon.relay` route.

### Where the claim comes from — and why there is no second key

| what                     | where it comes from                                 | why it cannot come from anywhere else                                                                                                                                   |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| signing key              | `[settlement.evm]`                                  | the channel's on-chain participant **is** this node's settlement address — the same key ADR 0024's outbound peer claims are signed with                                 |
| EIP-712 domain           | the **target's** x402 greeting (`extra.settlement`) | its claim gate recovers the signer under the domain **it** resolved for the channel; signing under yours recovers a different address                                   |
| nonce, cumulative amount | the target's `POST /ilp/claim-state`                | the **receiver** is the authority on its own watermark — a nonce that does not advance it is refused as a replay, and a guessed one either replays or silently overpays |
| channel id               | `[announce] pay_channel`                            | the only fact neither side can derive                                                                                                                                   |

`pay_channel` is deliberately **not** a `[[client_channels]]` row. That table is channels this node
_receives_ on ("whose signature I accept"); this is a channel it _pays_ from. Putting one channel in
both roles is the same namespace collision `Config::load` already refuses between the peer and client
books.

Open the channel however you normally would — the target's `POST /channels`, or any TOON client —
then name its 32-byte on-chain id here. The target does not need to have heard of you: an
unaffiliated buyer's channel resolves from chain (issue #502).

### The carriage is negotiated, but the BTP URL is not

A route may be pinned to one transport (issue #701), and `handle_ilp` checks transport **before** it
checks payment — so a route pinned to `btp` answers a _paid_ HTTP request with the same x402 terms it
answers an unpaid one, however correct the claim.

The greeting says which carriage a route needs (`extra.requiredTransport`), so the command negotiates
first and then picks: HTTP for a route with no restriction (`g.toon.ario` today), BTP for one pinned
to it (`g.toon.relay` today). You do not tell it which to use.

What it **cannot** negotiate is the BTP URL itself. A target that configures its own `[announce]`
section now carries one in the greeting as `extra.btpEndpoint` ([issue
#807](https://github.com/toon-protocol/connector/issues/807)), but a target that does not carries
no BTP endpoint at all — before #807 none did, verified live, its `extra` keys being exactly
`endpoint` (the HTTP one), `ilpAddress`, `price`, `requiredTransport`, `sessionLeaseTtlMs`,
`settlement`, `settlements`. So this stays a value you supply. Deriving one by swapping the
HTTP URL's scheme and appending `/btp` would be right on this fleet and wrong for any operator whose
deployment does not mirror it — the same class of guess `relay_url` and `payTo` have already
punished. So pass `--btp-url`, or set `[announce] publish_btp_url`, and if a BTP-only route comes
back with neither, the command refuses and says where to find it: **the target's own kind:10032
announce carries `btpEndpoint`.**

On BTP the claim rides as a `payment-channel-claim` protocolData entry as **raw JSON**, where the
HTTP carriage base64s the identical bytes into a header. Nothing about the announce changes
otherwise, and the two carriages share one claim watermark on the channel. The command also reads
`extra.sessionLeaseTtlMs` and will not wait for an answer longer than the far side will hold the
session open.

## Routing it yourself

`--via-own-routing` sends the packet through this node's own routing table instead — the same
`Connector::handle_prepare` call `POST /packets` makes. It is a coherent thing to want (it pays over
an existing peering rather than a client channel), but it is the opt-in rather than the default
because it makes the URL argument mean two things at once: who you _ask_ and, only if your routing
table happens to reach them, who you _pay_.

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
# publish_btp_url = "wss://…/ilp/btp"    # the TARGET's BTP endpoint; default for `--btp-url`
# pay_channel = "0x…"                    # the channel this node PAYS from (32-byte on-chain id)
# route_publish / route_store            # override the `.relay`/`.store` suffix heuristic
# asset_code = "USDC"                    # default
# asset_scale = 6                        # default
# solana_chain_id = "solana:devnet"      # default; qualifies the greeting's bare "solana"
# ttl_secs = 600                         # default; NIP-40 expiration
# identity_key_file = "/root/keys/announce.key"  # carry over a durable Nostr identity; see below

# An operator notice (toon#183, issue #912) -- config only, never composed
# or inferred here. Omit all four for no notice, the default and the
# common case. notice_id/notice_summary/notice_url must all be set
# together; notice_severity is optional and defaults to "info".
# notice_id = "2026-08-relay-migration"
# notice_severity = "action-required"    # "info" (default) | "action-required"
# notice_summary = "Read the migration notes before Friday"
# notice_url = "https://example.com/notices/1"
```

### The Nostr identity: `[signer]` by default, `identity_key_file` to carry one over

The event this command publishes is signed with this node's own `[signer]` identity by default —
the same key that opens gift wraps and answers `GET /ilp/identity`. That is correct for a node
announcing itself for the first time.

It is **not** correct for a node that is **taking over announcing from something else that already
published under a different key** — most concretely, the `announcer` sidecar this subcommand
replaces (issue #784), which loads its own identity from `ANNOUNCER_IDENTITY_SECRET_KEY_FILE`
independently of any connector's `[signer]`. If a genesis peer seed (or any client's cache) already
pins the sidecar's pubkey, switching to `connector announce` with no `identity_key_file` signs every
future announce under a **different** pubkey — the seed goes stale, and every client relying on it
fails to bootstrap with `EOSE, found 0 events`, silently, until someone re-publishes the seed and
every already-shipped client is re-pointed at it.

**When retiring the sidecar, set `[announce] identity_key_file` to the exact path the sidecar's
`ANNOUNCER_IDENTITY_SECRET_KEY_FILE` named** (e.g. `/root/keys/announce.key` on the apex box) before
turning the sidecar off. This node then signs under the identical pubkey the sidecar always did, and
the cutover is invisible to every client already discovering by that identity. Skipping this step is
not a config rollback: the seed is baked into published `@toon-protocol/core`, so recovering from a
silent pubkey change is a republish chain plus re-pointing every client already in the wild.

A `key_file` identity is required either way (see below) — `identity_key_file` only changes _which_
key file that identity comes from.

### Three URLs, and conflating any two is the bug

|                                      | what it is                                  | where it comes from            |
| ------------------------------------ | ------------------------------------------- | ------------------------------ |
| **through**                          | the edge you publish **through** — pay here | the CLI argument               |
| **`http_endpoint` / `btp_endpoint`** | where clients **pay you**                   | this section                   |
| **`relay_url`**                      | where clients **read you for free**         | this section, and **optional** |

`relay_url` is **not** derivable from the through-URL, and must not be inferred from it: the relay
you publish _through_ need not be the relay you advertise for _reads_. They coincide on the devnet
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
   needs the scalar itself — a KMS-held `[signer]` cannot announce, unless
   `[announce] identity_key_file` supplies a file-based one instead (see above — this is the
   field that matters when retiring the sidecar).
4. **A `--btp-url`, if the target's route is pinned to BTP** (issue #701). **The devnet apex pins
   `g.toon.relay` to `transport = "btp"`**, so an announce there is paid over BTP and needs the
   apex's `wss://…/ilp/btp` endpoint supplied. Without it the command refuses up front, before
   anything is signed.

With `--via-own-routing`, replace (1) and (2) with: a `[[routes]]` entry reaching the relay's
connector, and a channel with whoever carries it (over a peering, the `[[peer_channels]]` row it
already needs). (4) does not apply — the client-edge transport policy applies to clients.

## Cutting a prefix over from one publisher to another

> **This section assumes the two publishers hold _different_ identity keys** — the old one announces
> under its key, the new one under its own. That is true of both worked examples below, and it is
> what makes "bring the new one up first" safe. **It is not true when the new publisher _adopts_ the
> old one's key**, and under adoption the order below is exactly backwards. See
> [Cutting over under an adopted key](#cutting-over-under-an-adopted-key) at the end of this section
> before running any of it.

A prefix that moves from one node's announce to another node's announce is a **two-box, ordered**
change, and the repo cannot do it for you: one half is a config file and one half is a running
container on a different machine. The devnet `g.toon.ario` cutover (issue #833) is the worked
example — the apex's announcer sidecar
(`infra/linode-node/docker-compose.node.announcer.yml`) stops advertising a prefix it only
**forwards**, and the store box starts advertising it under the identity that actually **terminates**
it (`infra/linode-store/connector-rust.toml`'s `[announce]` +
`infra/linode-store/docker-compose.store.announce.yml`).

Run it in this order, on the boxes named:

1. **STORE box — open and fund the store→relay client channel**, then write its 32-byte on-chain id
   into `[announce] pay_channel` in the box's `connector-rust.toml`. (The counterparty was the
   **apex** until issue #871 repointed this announce: toon-meta#310 retires the apex, and the relay
   box is the fleet's only public write ingress once it goes, so the store buys relay writes
   directly. `[announce] publish_btp_url` and the compose file's through-URL name the relay box for
   the same reason.) The committed file carries a clearly-marked `0xdead…` placeholder there (issue
   #853): the field's **shape** is in git, but the real id is a live fact no diff can supply, so
   until the box's own copy names a funded channel every run fails. (Remember the bind-mounted box
   config **leads** the repo copy — edit the file the container mounts.)
2. **STORE box — bring the publisher up**:

   ```
   docker compose -f infra/linode-store/docker-compose.store.yml \
                  -f infra/linode-store/docker-compose.store.rust.yml \
                  -f infra/linode-store/docker-compose.store.announce.yml \
                  up -d announce
   ```

   Then read `docker compose logs announce`. `[announce] OK` is the only line that means published;
   `[announce] FAILED rc=…` names the reason and the loop retries on the next tick.

3. **VERIFY on the relay, not in the logs.** Query the relay for a kind:10032 whose author is the
   **store box's own** pubkey — the one `GET /ilp/identity` on that box answers with, which on the
   live devnet store box today is
   `499cdd71c7c3eab8d9b35f88ec9cde29018461e4bef86389004abcd7cfa1108a` — and confirm the event's
   address list actually carries `g.toon.ario`. A published event under the right key is the only
   evidence that counts.
4. **ONLY THEN, APEX box — retire the stopgap**: deploy the announcer overlay with `g.toon.ario`
   dropped from `ANNOUNCER_ILP_ADDRESSES` and restart the sidecar so the new value is read. Keep
   `ANNOUNCER_ROUTE_STORE` pinned while doing so: `routes.store` is **derived** from the address
   list when that variable is unset, so dropping the address also silently repoints the announce's
   store hint at a guessed `<publish-prefix-minus-.relay>.store` no node routes (issue #841).

**Doing step 4 before step 3 leaves the prefix announced by nobody.** The old publisher's event is
gone (or expires with its NIP-40 `ttl_secs`) and no replacement exists, so a client bootstrapping in
that window finds no route to the prefix at all — the same outage the stopgap was added to end. Two
publishers **holding different keys** overlapping for a few minutes is the _safe_ direction to be
wrong in; zero publishers is not. Two publishers holding the **same** key is neither — they overwrite
each other in one slot, and no amount of waiting resolves it.

### Cutting `g.toon.relay` over: the relay box's own publisher (issue #843)

Same shape as the `g.toon.ario` cutover above, with one simplification: the relay box's publisher
pays **itself** (`--via-own-routing`, since it terminates `g.toon.relay` directly), so there is no
channel to fund first — the `[[routes]]` entry that replaces requirements (1)/(2) of "What the node
needs before this can work" is already committed, and `[announce] pay_channel` is not needed at all.
Requirement (4) does not apply either, even though that route is pinned to `transport = "btp"`: the
transport policy is enforced at the client edge, and this packet is handed to the node's own routing
without crossing it. See `infra/linode-relay/connector-rust.toml`'s `[announce]` section for the
fuller argument.

1. **RELAY box — bring the publisher up**:

   ```
   docker compose -f infra/linode-relay/docker-compose.relay.yml \
                  -f infra/linode-relay/docker-compose.relay.rust.yml \
                  -f infra/linode-relay/docker-compose.relay.announce.yml \
                  up -d announce
   ```

   Then read `docker compose logs announce`. `[announce] OK` is the only line that means published;
   `[announce] FAILED rc=…` names the reason and the loop retries on the next tick.

2. **VERIFY on the relay, not in the logs.** Query the relay for a kind:10032 whose author is the
   **relay box's own** pubkey — the one `GET /ilp/identity` on that box answers with — and confirm
   the event names `g.toon.relay`. Read its `ilpAddress`, not `ilpAddresses`: a single-address
   announce omits the plural field entirely (`ilpAddresses.length > 1`), so grepping for the list is
   how a correct event reads as a failure. A published event under the right key is the only evidence
   that counts, exactly as in the `g.toon.ario` case above.
3. **ONLY THEN, APEX box — retire the stopgap**: deploy the announcer overlay with `g.toon.relay`
   already dropped from `ANNOUNCER_ILP_ADDRESSES` (issue #843) and restart the sidecar so the new
   value is read. Keep `ANNOUNCER_ROUTE_STORE` **and** the new `ANNOUNCER_ROUTE_PUBLISH` pinned while
   doing so — both hints are **derived** from the address list when their override is unset, and
   dropping `g.toon.relay` from that list without pinning `ANNOUNCER_ROUTE_PUBLISH` silently repoints
   `routes.publish` at the store hint instead (the same class of trap issue #841 hit from the other
   direction). `ANNOUNCER_PROBE_ROUTES` is pinned in the same commit and is load-bearing for the same
   reason: it defaults to the address list, and a probe of the bare `g.toon` prefix — which no route
   serves — is skipped silently, dropping `routePrices` and every settlement field from the event.

**Doing step 3 before step 2 leaves `g.toon.relay` announced by nobody**, for the same reason as the
`g.toon.ario` case: the apex is still the box that actually _terminates_ `g.toon.relay` today (the
peering forward is issue #820, not yet live), so this cutover only changes **which identity**
announces it — but the window between "apex stops" and "relay box confirmed publishing" is still a
real outage if it is skipped.

### Cutting over under an adopted key

When the new publisher is given the **old publisher's** identity key rather than its own — so that
already-deployed clients, which trust one author, keep resolving after the old box is gone — every
ordering rule above inverts. This is the devnet apex retirement (toon-meta#310); the operator runbook
of record is **toon-meta#311**, and this section exists so nobody reaches for the different-key order
by habit.

**Why the order inverts.** `kind:10032` sits in NIP-01's regular replaceable range, so a relay keeps
exactly one event per `(pubkey, kind)`, and there is no `d` tag to separate two publishers
(`crates/connector-signer/src/nostr.rs`). Under a shared key the old sidecar and the new loop
overwrite each other on their own refresh cadences, and a client bootstrapping from the seed gets
whichever published last. The overlap that is merely untidy under different keys **is** the outage
under one.

So: **stop the old publisher, confirm it stopped, and only then bring the new one up.** The new
publisher's first event replaces the old one's last cleanly, and nothing overwrites it afterwards.

**There is no announced-by-nobody gap in that order**, and this is worth stating because it is the
objection the different-key order was built to answer. The relay neither deletes nor filters expired
events, and the seeded bootstrap path takes the most recent event without checking expiry — so
between "old publisher stopped" and "new publisher's first `[announce] OK`" a client still resolves
to the old announce, which is still correct as long as the old box is still serving. The NIP-40
`ttl_secs` both publishers stamp binds only the `kind:10036` seed-relay path, which _does_ skip
expired announces. Treat the TTL as a reason to keep the handoff brisk, not as a correctness
deadline — and do not begin it after the old box has stopped serving.

**Verification cannot use the author.** Every "query the relay for a kind:10032 whose author is the
box's own pubkey" step above becomes useless the moment the key is shared: both publishers are that
author. Verify on the announce's **content** instead — the `ilpAddress` and `httpEndpoint`/
`btpEndpoint` differ between the two boxes even when the pubkey does not — and on `created_at`, which
must advance on the new publisher's cadence and never step back to the old box's values. A single
reversion means the old publisher is still alive.

**Stop the loop before you edit the config, not after.** The announce overlay's loop re-executes
`connector announce --config …` every cycle and re-reads the config file each time, so setting
`[announce] identity_key_file` on a box whose loop is running flips that box's identity on the next
tick with no restart and no further action. An operator who edits first and starts second has already
opened the concurrent window they were trying to avoid. Bring the loop down, edit, then bring it up
in the order above.

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

The **default client path is never blocked**, and does not need to be: it signs a _client_ claim by
hand against a channel whose watermark authority is the receiver (asked over `POST /ilp/claim-state`,
never remembered locally), and it never touches `ClientPayoutLedger` — so there is no local mutable
money state to fork. Announcing to a route this node _terminates_ is likewise unblocked, and so is
`--dry-run`.

When it does refuse: stop the node, announce, start it again — or drop `--via-own-routing`.

> **Why `--via-own-routing` cannot help a node like the store box.** On a node whose only peering is
> **accept-only** — no `endpoint`, the far side dials in — a second process cannot originate over
> that peering at all: the accepted session belongs to the serving process, and this one gets an
> empty transport and `T01 peer unreachable`. That is the devnet store box's shape, and it is
> exactly why the client path is the default: paying the URL needs no peering and no route.

## Reading the failures

| what you see                                                               | what to change                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requires the 'btp' transport … no BTP endpoint was given`                 | pass `--btp-url`, from the target's own kind:10032 `btpEndpoint`.                                                                                                                           |
| `the BTP session with … failed`                                            | the endpoint did not upgrade, or the session closed before answering.                                                                                                                       |
| `no [announce] pay_channel`                                                | open a funded channel with the node you are paying and name its on-chain id.                                                                                                                |
| `would not report this node's claim state`                                 | that node cannot resolve the channel, or its counterparty is not this node's settlement address.                                                                                            |
| `spendable headroom … but the announce costs`                              | fund the channel. Nothing was sent.                                                                                                                                                         |
| `F02 no route to destination`                                              | `--via-own-routing` only: this node has no `[[routes]]` entry reaching the destination.                                                                                                     |
| `F03`                                                                      | the amount did not cover what the terminating side charges on arrival (ADR 0028's subtraction — this hop forwards `amount - fee`). Raise the forwarded route's `price`, or lower its `fee`. |
| `F01 gift wrap could not be opened`                                        | the through-URL **forwards** the destination onwards rather than terminating it, so the wrap was sealed to a hop. Point `--to` at a route that terminates where the through-URL is.         |
| `T01 peer unreachable`                                                     | the route's next hop is a peering this process cannot dial.                                                                                                                                 |
| `answered ... instead of 402 x402 terms`                                   | that edge serves no route for the destination you asked about.                                                                                                                              |
| `the packet FULFILLed ... but the relay's write ingress answered HTTP 4xx` | the money is spent; the relay refused the event. Check `--target`, and that the ingress wants `{"event": ...}`.                                                                             |
