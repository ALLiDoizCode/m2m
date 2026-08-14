# Devnet route pricing

The committed source of truth for what every devnet route charges, and why
(connector#785). Before this existed the decisions were spread across comment
blocks in four config files, which is how a hand-edit on one box sat
unreconciled for twenty hours.

For the mechanism these numbers are plugged into — who pays whom, on which channel, and why
`price - fee >= next hop price` is an F03 rather than a subsidy when it is violated — see
[`protocol/money-model.md`](protocol/money-model.md).

All prices are in **base units of 6-decimal USDC** (ADR 0010;
`docs/usdc-cross-chain-settlement.md`'s "6 decimals everywhere" is canonical
across EVM/Solana/Mina, not a TypeScript-only asset config). So `1000` is
0.001 USDC and `1` is 1 µUSDC.

**The apex is retired (issue #872, toon-meta#310 / toon-meta#313's live
cutover).** Every row below that used to be a forward THROUGH the apex is
gone along with it; the fleet is two boxes now, each terminating its own
prefix directly for its own clients. `g.toon` remains the namespace root in
the wire protocol, but nothing answers at it — see "The apex forward
(retired)" below for the history this replaces.

## The table

| Route                                                | Price    | Fee | Where                                    | Guarded by             |
| ---------------------------------------------------- | -------- | --- | ---------------------------------------- | ---------------------- |
| relay `g.toon.relay` — terminate                     | **1**    | —   | `infra/linode-relay/connector-rust.toml` | `EXPECTED_RELAY_PRICE` |
| store `g.toon.ario` — terminate                      | **1000** | —   | `infra/linode-store/connector-rust.toml` | `EXPECTED_STORE_PRICE` |
| store `announcePrice` (retired TypeScript concept)\* | **2000** | —   | — (historical, file deleted #901)        | —                      |

\* The retired TypeScript config that carried this figure, `infra/linode-store/connector.yaml`, is
deleted (issue #901) — it no longer fronted traffic (see "The TypeScript fleet" below) and was not a
current source of truth for anything. The row survives only as the historical origin of the `2000`
figure: the Rust `connector announce` that replaced `selfAnnounce` configures no announce price at
all, so there is no committed literal to repoint this citation at. See "`announcePrice` 2000" below.

Last verified live against both boxes via the unauthenticated
`GET /ilp/routes/price?destination=…` (ADR 0022 puts configuration answers on the free side of the
answering/announcing line):

```
relay g.toon.relay        -> 1
store g.toon.ario         -> 1000
```

## Why the relay route is 1 and the store legs are 1000

**`g.toon.relay` carries buzz huddles**, which is per-audio-frame at 49 fps
over BTP (toon-meta#262). 1 µUSDC is a coherent per-frame price; 0.001 USDC
per frame is not. A general-write price is the wrong frame for that route.
This was an owner decision on 2026-08-04, ratifying a value the live box had
already been serving — the repo moved to the box, not the box to the repo.

**The store legs stay at 1000** because a store write is a one-shot upload
from an arbitrary buyer, not a high-frequency stream. Nothing amortises a
handshake there, which is also why the relay route pins `transport = "btp"`
(#701) while the store legs keep the default `both`.

## The apex forward (retired, issue #872)

Until issue #872 removed it, the apex sat in front of both boxes and forwarded to them over a paid
peering — this section is kept as the historical record of the arithmetic that governed it, not as a
description of anything currently live.

The apex charged its own client `1002` for `g.toon.ario`, kept a `fee` of `2`, and forwarded the
remaining `1000` to the store's own terminating route — ADR 0028's arithmetic (`amount == price` at
each hop) made a short forward an F03 rather than a silent subsidy once #754 made a terminating
connector charge its price on a peer-wire arrival, so `1002`/`2` was the only pair that both paid the
store its `1000` and matched that rule.

For `g.toon.relay` the apex charged `1` and kept a `fee` of `0` (owner decision, 2026-08-06): the
relay carries buzz huddles at 49 fps, so any non-zero apex fee would have forced `apex.price` above
`relay.price`, doubling the per-frame client cost for a workload billed 49 times a second. Zero fee
kept that cost flat while the arithmetic still held: `1 - 0 = 1 >= 1`.

The `EXPECTED_APEX_FORWARD_PRICE`/`EXPECTED_APEX_FORWARD_FEE` (and their relay-forward siblings)
constants that guarded this arithmetic in `crates/connector-bin/tests/devnet_configs_load.rs` are
removed by issue #872 along with the peering and the `infra/linode-node/` config that named them —
with no hop, there is no fee and no peer arrival, so the F03 peer-arrival case they guarded against
cannot arise on this fleet any more. `EXPECTED_RELAY_PRICE` and `EXPECTED_STORE_PRICE` still guard
each surviving box's own terminating price directly.

`transport = "btp"` was only ever legal alongside `handler_url` —
`ConfigError::PeerRouteHasTransport` refuses it on a `peer_id` route
(`crates/connector-config/src/error.rs:125`) — so the pin always lived on the relay's own
terminating route (committed in #816/#823), never on the apex's forward. That is unchanged by the
apex's removal: the relay box's `[[routes]]` entry for `g.toon.relay` still pins `btp` for its own
direct clients.

## `announcePrice` 2000

This was the retired TypeScript connector's fixed figure for what the store's
self-announce had to cover: the apex's `g.toon.relay` terminate price plus this
box's own forward fee, with headroom. It was never a route price and was never
comparable to the figures above.

The Rust `connector announce` mechanism that replaced `selfAnnounce`
(`crates/connector-cli/src/announce.rs`) does not configure this figure at
all — there is nothing to repoint the citation at. Each announce run asks the
publish target's own x402 greeting for its live price and pays that; only when
it originates through its own routing (`--via-own-routing`) does it add this
box's own `[[routes]]` forwarding fee on top, ADR 0028's arithmetic from the
originating side (`amount_to_pay`). Either way the amount tracks the target's
live price instead of needing a hand-maintained buffer like `2000`.

## Retired names

- **`g.toon.store`** — retired 2026-08-05 (owner decision). It was an alias for
  the same store app at the same price, kept so a client arriving directly at
  the store edge was priced identically to one arriving via the apex's forward.
  The apex dropped that forward, so the alias had nothing left to mirror. One
  name for one app; `g.toon.ario` survives because it is the one compiled into
  a shipped client (`desktop/src/shared/api/toonTransportConfig.ts`).

- **`g.toon.relay.ario`** — retired by #820, resolving the divergence this
  section used to track. It was never actually reachable: the apex's Rust
  route table only ever declared `g.toon.relay` and `g.toon.ario`, so
  longest-prefix matching always dropped `g.toon.relay.ario` into the
  `g.toon.relay` route — which the apex TERMINATED (against `relay:3100`)
  until #820, so every arrival here 404'd for free (the retired TypeScript
  config's own comment had called this exact failure out: `g.toon.relay.ario`
  "MUST be listed... so longest-prefix routing forwards it to the store box
  instead of falling through to the relay terminate route"; the Rust port
  dropped the route and reproduced the failure it warned about). #820's flip
  of `g.toon.relay` to a peer forward would only have relocated the accident
  and made it more expensive — traversing the apex↔relay peering, consuming a
  real signed claim, only to 404 at the relay box's own `g.toon.relay`
  terminate route, since that box's own table has no `.ario` child either.
  Nothing in a shipped client addresses this name (buzz pins
  `storeDestination: "g.toon.ario"` in compiled code), so #820 retired it —
  deleting the store's `g.toon.relay.ario` route — rather than repairing it
  with a dedicated forward-to-store row.

## The TypeScript fleet

Both surviving boxes (store, relay) serve the **Rust** connector on the public
door — verified by
`GET /ilp/identity` answering, by `invalid packet type byte` (a string that
exists only in `crates/connector-domain/src/error.rs`), and by nginx returning
`410 Gone` for the transitional `/rust/` prefix because Rust took over
`location /`.

No TypeScript `connector.yaml` is left in this repo at all: the store's copy went
with issue #901, along with the retired `connector` service in
`infra/linode-store/docker-compose.store.yml` that read it, and the apex's went
with the rest of `infra/linode-node/` (issue #872). Neither was ever a second
source of pricing truth; the TypeScript retirement itself is tracked in #714.

`infra/devnet-manage.sh redeploy` no longer needs to dodge a dead service (#851,
simplified by #901, finished by #872): neither surviving box's base compose file
declares a TypeScript `connector` any more — the store's was deleted, the relay
never had one (#816), and the apex's went with the box — so both legs simply
compose their base file with their Rust overlay and bring up the whole file set,
with no service list and no `--no-deps`, like the relay leg always did. The
provisioning paths (`up`, `store`) are a separate matter: they still run each
box's `bootstrap.sh`, which brings up the base file alone.
