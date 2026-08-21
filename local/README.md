# `local/` — the shipped image, run against real chains

One connector image, real containerised chains, a real packet. That is the
whole scope.

```sh
make local-up        # build the image, start the chains, provision keys, run it
make local-rehearse  # send a real packet; non-zero unless it is fulfilled
make local-down
```

Or `make local-verify` for all three, which is what CI runs
(`.github/workflows/local-topologies.yml`).

## What this is for, and what it is not

`cargo test` covers the connector's behaviour far better than a container can.
It spawns its own `anvil` and `solana-test-validator` **per test**, deploys into
them and throws them away (ADR 0007) — nothing under `crates/` dials
`localhost:8545` or `localhost:8899`, and `make anvil-up` before `cargo test`
changes nothing.

What `cargo test` structurally cannot check is the thing every deploy depends
on: that **the image**, running as uid 10001, with a mounted `connector.toml`,
mounted key files and a real volume at `/app/state`, boots and moves a packet.
That is this, and only this.

`promote-to-fleet.yml` checks half of it — the candidate image against the
fleet's own committed configs — and can only _warn_ on the other half, because
a GitHub runner has no chain to reach and ADR 0009 makes an unreachable
settlement RPC a refuse-to-start. Here there is a chain, so it is an assertion.
The two are complementary: promotion proves image-matches-fleet-config, this
proves image-serves-and-settles. Neither replaces the other, and this one
deliberately does **not** use the fleet's configs — its own name local
container URLs, which is exactly the substitution ADR 0041's gate exists to
avoid making.

## Connector layer only

No relay, no store, no faucet. Composition of a connector with a real app lives
in that app's repository; this repo builds only the connector image. The thing
behind the route here is `stub-app`, the image's second binary: it answers
`POST /`, holds no secret and does no cryptography, so it contributes nothing
to a packet's fulfilment — the connector derives that itself (ADR 0019).

A `deploy/connector-rust/local-stack/` bundle used to do a bigger version of
this with the published relay image. It is deleted: it was app-layer by
construction, it pinned a relay sha that would rot, and its chain ran on the
_host_ behind a hand-run Python TCP forwarder because `anvil` binds loopback.
Here the chains are the same compose services `make anvil-up` starts, merged
into one project, so the connector reaches them by service name and there is
nothing left to forward.

## Topologies

| Topology         | What it proves                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`solo/`](solo/) | The image boots on a mounted config with **both** settlement backends live at once, and a real packet reaches the app behind its one route. |

`two_ledgers_never_merge.rs` is named for the both-chains concern and proves it
in-process; `solo` is the only place a node is actually stood up with an EVM and
a Solana backend attached simultaneously.

## Keys and money

Both are the same rule: nothing is committed, and nothing is assumed.

`local/keys.sh <topology>` generates every key into `local/.keys/<topology>/`,
which is gitignored, and then **funds** it. There is no fixed throwaway key
checked in anywhere, so there is no allowlist exception to reason about and no
key in git history to explain later. Every `key_file` in a committed
`connector.toml` here is a path (ADR 0009, ADR 0012).

Per node it writes `signer.key`, `settlement.key`, `settlement-solana.key`,
`operator-bearer-token`, `operator-write-keys` and `operator-send.key`. The last
two are a pair: the allowlist holds the **public** half (derived by the same
binary that will sign, so the two cannot disagree), and `connector send` holds
the private half. Ask for the allowlist value directly with:

```sh
connector send --operator-key <file> --print-keyid
```

Funding involves **no faucet on either chain** — the faucet is an app-layer
service and is not part of the connector:

- **EVM.** anvil's genesis funds account 0 with 10,000 ETH; it is the deployer
  `DeployLocal.s.sol` runs as, so it owns the settlement topology. ETH is a
  plain transfer from it and USDC is a `mint` — `MockERC20` is mintable, so
  nobody's balance runs down.
- **Solana.** `solana airdrop` from the validator's genesis. The mock USDC mint
  is seeded by `make solana-mint-usdc`, which **fails** rather than warns when
  it cannot: a validator without that mint cannot satisfy the committed
  `token_address`, and the node will refuse to start.

Devnet funds completely differently — the faucet box and its treasuries, on
public chains. Do not carry an assumption from here to there.

## Sending a packet

`connector send` is the binary's third verb. It forms the packet the operator
surface cannot form for itself: an OER `Prepare` whose payload is gift-wrapped
to the terminating connector's identity (ADR 0018) under a condition minted
from the fulfilment that wrap derives (ADR 0019), inside an RFC 9421-signed
`POST /packets` (ADR 0008).

```sh
connector send \
  --operator  http://127.0.0.1:3000 \   # whose /packets originates it
  --operator-key local/.keys/solo/operator-send.key \
  --to        g.local.solo \            # the ILP destination
  --seal-to   http://127.0.0.1:3000 \   # the connector that TERMINATES it
  --body      payload.json \
  --expect-fulfill
```

`--seal-to` is separate from `--operator` because a payload is sealed to the
node that terminates it, which in a multi-hop topology is not the node the
packet is handed to. There is no way to discover that node's identity from the
destination address today; when ADR 0050 ships (`GET` on a connector's URL
returns its self-description) this flag becomes optional.

`--expect-fulfill` is what makes the rehearsal a gate. Without it a REJECT is
reported and the process exits 0 — right for an operator probing what a route
does, wrong for CI, where a run that prints `REJECT F02` and goes green is the
same nothing-asserted success ADR 0007 bans elsewhere.
