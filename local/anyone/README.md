# `local/anyone` — the client edge over a `.anyone` hidden service

A connector reachable **only** at a hidden-service address, and the
[toon client](https://github.com/toon-protocol/toon-client) paying it over that
circuit. Two isolated docker networks, so a fulfilled packet is evidence of a
circuit rather than evidence of a docker network.

```sh
export TOON_CLIENT_REPO=../toon-client     # with `pnpm build` already run
./local/anyone/run.sh verify               # up + pay + down
```

## What this is for, and how it differs from `local/onion`

[`local/onion`](../onion/) proves a **peering**: two connectors that cannot
reach each other, exchanging BTP frames over a circuit. This proves the **client
edge**: the real payer — a different repository's library, not `connector send`
— discovering, pricing, and paying this node over one.

They pin **different daemon images on purpose**, and that is the finding this
topology exists to hold on to.

## The TLD renamed, and the two repositories are on opposite sides of it

Anyone Protocol's `anon` renamed its hidden-service TLD between the releases the
two repositories pin. Verified on the binaries and then on the wire:

|                                   | `anon` v0.4.9.7          | `anon` v0.4.10.2                 |
| --------------------------------- | ------------------------ | -------------------------------- |
| Pinned by                         | this repo, `local/onion` | `toon-client`, as `ANON_VERSION` |
| Hidden-service TLD                | `.onion`                 | `.anyone`                        |
| The other spelling, in the binary | `.anyone` absent         | `.onion` — **0 occurrences**     |

v0.4.10.2 writes `<56-base32>.anyone` into `HiddenServiceDir/hostname`, routes
it, and **refuses the same address spelled `.onion`** (`SOCKS5 … (4)`, host
unreachable). v0.4.9.7 does the exact opposite.

So the two codebases cannot interoperate over a hidden service:

- `toon-client` accepts `.anyone` only, and refuses `.onion` by name.
- this repository accepts `.onion` only — `const ONION_SUFFIX = ".onion"` in
  `connector-config/src/peer.rs`, and `.anyone` appears **nowhere** in the repo.

Neither side is wrong on its own. **This repository is the side that is behind**:
v0.4.9.7 is from October 2024 and predates the rename. The fix is here — bump
the sidecar image and widen the suffix check — and until it lands, this topology
runs the connector with a workaround.

### The workaround, and why it is not the fix

`connector.toml` sets `peer_allow_plaintext_endpoints = true`. That is what lets
this node **load and advertise** `http://<addr>.anyone/ilp`, because

```rust
plaintext_permitted = allow_plaintext || is_onion_endpoint(url)
```

and `is_onion_endpoint` does not recognise `.anyone`. It is enough here only
because the connector **serves** and never dials out over the overlay, so the
other thing that function decides — which socket a dial leaves on — is never
asked. It does **not** make this connector able to reach a `.anyone` peer, and
it is a loopback-and-test switch that must never be set on a deployed node.

## Use a released connector image, not `main`

The default image is `ghcr.io/toon-protocol/connector:rust-2026.08.28.1`. That
is deliberate: `main` is ahead of what `toon-client` has vendored, and a packet
built against the older wire vectors is refused with

```
400 Bad Request: invalid packet type byte: expected 12 (PREPARE), 13 (FULFILL) or 14 (REJECT)
```

which reads like a transport fault and is not one — it reproduces with no
circuit at all, over plain loopback. `pnpm --filter @toon-protocol/client
vectors:check` in the client repo reports the drift, and
`fe996af2` (ADR 0069, "the execution condition leaves the wire") is the commit
that caused it. Point `ANYONE_CONNECTOR_IMAGE` at a build of `main` once the
client has vendored that change.

## What the rehearsal asserts

`pay.mjs` runs on `anyone-payer` and goes further than "it fulfilled", for the
reason `local/onion`'s sender does: a fulfil alone cannot see a claim that
repeats itself.

1. **`describe`** over the circuit — the free GET that bootstraps everything,
   before anything is paid for.
2. **`price`** is asked for, never derived.
3. **`channel.open`** on chain, which does _not_ ride the circuit here (see
   `proxyRpc` in `pay.mjs`).
4. **A paid packet** — sealed payload, signed claim, 32-byte fulfilment, and the
   app's answer coming back through the connector.
5. **A second packet**, whose nonce must **strictly advance** the watermark.
6. **The connector's own watermark**, asked over the circuit, must equal what
   the payer signed. Two independent records of one channel, reconciled rather
   than assumed.

## The isolation, and why it is structural

- `connector`, `stub-app` and `anon-b` are on `anyone-app`; the payer and
  `anon-a` are on `anyone-payer`.
- `connector` publishes **no host port**.
- From `anyone-payer`, a direct dial to the connector times out and the name
  `connector` does not resolve — docker's embedded DNS is per network. Both were
  checked.
- `anvil` joins both, because the payer opens a channel on the chain the
  connector settles on. A container on two bridges forwards nothing between
  them.

## Two traps this cost an afternoon to find

**`anon` resolves `HiddenServicePort`'s target when it PARSES its config.** A
container name that does not exist yet aborts the daemon before it runs — and it
aborts by crashing:

```
[warn] Unparseable address in hidden service port configuration.
free(): invalid size
```

That is unavoidable here, because the connector's config names an address only
the daemon can generate, so the daemon must start first. `anonrc-b` names a
**fixed IP** instead, and `compose.yml` pins the connector to it.

**No image is published for v0.4.10.2** — ghcr's `ator-protocol` tags stop at
v0.4.9.7. `anon-image/` builds one by overlaying the official release binary
(sha256-verified, the same figure `toon-client` records) onto that image. The
binary is statically linked, so nothing else has to come with it.

## Not in `local_topologies_load.rs`, on purpose — revisit when #1284 lands

`connector.toml` here is deliberately **absent** from that test's `EVERY_CONFIG`
list, which is otherwise "every committed config under `local/`". Adding it today
would assert that this config loads, and it only loads because of
`peer_allow_plaintext_endpoints = true`. That would bake the workaround into the
test suite and make the suite go red the moment someone does the right thing and
removes it.

When [#1284](https://github.com/toon-protocol/connector/issues/1284) lands and
`.anyone` is a recognised suffix, drop the opt-in from this config and add it to
`EVERY_CONFIG` — at that point it earns its place there, because it will load for
the same reason `local/onion`'s configs do.

## Why this is not a CI gate

For `local/onion`'s reasons plus one of its own: it needs a **second
repository's build** to be present and current. `local/README.md` is explicit
that these rehearsals are run deliberately, not on every push; do not "fix" this
one's absence from the workflow either.
