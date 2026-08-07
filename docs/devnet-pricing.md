# Devnet route pricing

The committed source of truth for what every devnet route charges, and why
(connector#785). Before this existed the decisions were spread across comment
blocks in four config files, which is how a hand-edit on one box sat
unreconciled for twenty hours.

All prices are in **base units of 6-decimal USDC** (ADR 0010;
`docs/usdc-cross-chain-settlement.md`'s "6 decimals everywhere" is canonical
across EVM/Solana/Mina, not a TypeScript-only asset config). So `1000` is
0.001 USDC and `1` is 1 µUSDC.

## The table

| Route                                                   | Price    | Fee   | Where                                    | Guarded by                             |
| ------------------------------------------------------- | -------- | ----- | ---------------------------------------- | -------------------------------------- |
| apex `g.toon.relay` — terminate, BTP-only               | **1**    | —     | `infra/linode-node/connector-rust.toml`  | `EXPECTED_RELAY_PRICE`                 |
| apex `g.toon.relay` — forward (decided, pending #820)\* | **1**    | **0** | `infra/linode-node/connector-rust.toml`  | —                                      |
| relay `g.toon.relay` — terminate                        | **1**    | —     | `infra/linode-relay/connector-rust.toml` | —                                      |
| apex `g.toon.ario` — forward to store                   | **1002** | 2     | `infra/linode-node/connector-rust.toml`  | `EXPECTED_APEX_FORWARD_PRICE` / `_FEE` |
| store `g.toon.ario` — terminate                         | **1000** | —     | `infra/linode-store/connector-rust.toml` | `EXPECTED_STORE_PRICE`                 |
| store `g.toon.relay.ario` — terminate                   | **1000** | —     | `infra/linode-store/connector-rust.toml` | `EXPECTED_STORE_PRICE`                 |
| store `announcePrice` (retired TypeScript concept)\*\*  | **2000** | —     | `infra/linode-store/connector.yaml`      | —                                      |

\* Not yet live. `infra/linode-node/connector-rust.toml` still carries the terminate row above it
today — a local `handler_url` route to `relay:3100` — because #820 (the actual peering + config
flip) has not landed. This row is the target #820 must write; it is pinned here first because #818
(this document) is a precondition #820 cannot be executed without. Once #820 lands, this row
replaces the terminate row above it, and the `relay` row becomes what actually answers the write.

\*\* `infra/linode-store/connector.yaml` is the retired TypeScript config — it no longer fronts
traffic (see "The TypeScript fleet" below) and is not a current source of truth for anything. The
row survives only as the historical origin of the `2000` figure: the Rust `connector announce` that
replaced `selfAnnounce` configures no announce price at all, so there is no committed literal to
repoint this citation at. See "`announcePrice` 2000" below.

Verified live against both boxes via the unauthenticated
`GET /ilp/routes/price?destination=…` (ADR 0022 puts configuration answers on
the free side of the answering/announcing line):

```
apex  g.toon.relay        -> 1
apex  g.toon.ario         -> 1002
store g.toon.ario         -> 1000
store g.toon.relay.ario   -> 1000
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

**The apex forward is 1002, not 1000, deliberately.** ADR 0028's arithmetic is
`amount == price`: the hop collects `price`, forwards `price - fee`, and earns
`fee`. The store terminates at its own committed 1000, so it must _receive_
1000; at 1000/fee 2 it would receive 998 and refuse. #754 made a terminating
connector charge its price on a peer-wire arrival, so 1002 is correct and
stays correct. The client's cost for that prefix is 1002.

## The `g.toon.relay` forward: price/fee split (decided, pending #820)

Once the apex stops terminating `g.toon.relay` against the co-located `relay:3100` and instead
forwards it over a peering to the relay's own box (`infra/linode-relay/`, #816/#823), ADR 0028's
arithmetic applies: the apex's client edge charges its own `price`, forwards `price - fee` over the
peer wire, and the relay box charges its own `price` again on arrival. A forward that is short —
`apex.price - apex.fee < relay.price` — is not a subsidy, it is an **F03** on every single write,
because ADR 0028 requires `amount == price` at each hop and #754 makes the terminating side charge
its own price against a peer-wire arrival.

**Decided (owner, 2026-08-06): `apex.price = 1, apex.fee = 0`; `relay.price = 1`.** Client cost per
write is unchanged (still 1 µUSDC) and the apex earns nothing for carriage on this leg —
deliberate, not an oversight, and not to be "fixed" by a later reader. `g.toon.relay` carries buzz
huddles at 49 fps (above), so any non-zero apex fee would have required raising `apex.price` above
`relay.price` to keep the arithmetic solvent, which at minimum doubles the per-frame client cost
(1 → 2 µUSDC/frame) for a workload billed per frame, 49 times a second. Zero fee is what keeps that
cost flat while the arithmetic still holds: `1 - 0 = 1 >= 1`.

**`transport = "btp"` moves with the terminating route.** It is only legal alongside `handler_url`
— `ConfigError::PeerRouteHasTransport` refuses it on a `peer_id` route
(`crates/connector-config/src/error.rs:125`) — so the pin the apex carries today
(`infra/linode-node/connector-rust.toml`, issue #701) moves down to
`infra/linode-relay/connector-rust.toml`'s own terminating route, where it already sits (committed
in #816/#823). **The apex therefore loses client-edge BTP enforcement on this prefix**: once the
route is a forward, an HTTP client can reach the apex's `g.toon.relay` and it is the relay box, not
the apex, that refuses it for the wrong transport.

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

## Known divergence: `g.toon.relay.ario`

**The apex does not serve this prefix, and its live price of `1` is an
accident, not a decision.** The Rust apex config declares only `g.toon.relay`
and `g.toon.ario`, so longest-prefix matching drops `g.toon.relay.ario` into
the `g.toon.relay` _terminate_ route — priced 1 and handled by `relay:3100`,
which 404s on a store payload.

The retired TypeScript config called this exact failure out:

> `g.toon.relay.ario` MUST be listed (it is more specific than `g.toon.relay`)
> so longest-prefix routing forwards it to the store box instead of falling
> through to the relay terminate route above (which 404s on /store).

The Rust port dropped the route and reproduced the failure it warned about.
The store box still terminates the prefix at 1000, so the far end is waiting
for traffic the apex never forwards.

**Nothing in a shipped client is affected** — buzz pins
`storeDestination: "g.toon.ario"` in compiled code — so this is a dead name
that reads as a live one. Resolving it is deliberately _not_ folded into this
document: it is either repaired (add the forward route at 1002/fee 2) or
retired the way `g.toon.store` was, and that is a routing decision rather than
a pricing one.

**Re-scoped to #820, not resolved here.** Landing #820's `g.toon.relay` forward without deciding
this first only relocates the accident, and makes it more expensive: today `g.toon.relay.ario`
404s for free at the apex's own `relay:3100`; after #820 it would traverse the apex↔relay peering
— consuming a real signed claim on that channel — only to 404 at the relay box's own
`g.toon.relay` terminate route, because the relay box serves no `.ario` route either
(`infra/linode-relay/connector-rust.toml` declares `g.toon.relay` alone). #820 must add
`g.toon.relay.ario` as its own forward-to-store route (mirroring the apex's existing `g.toon.ario`
row, 1002/fee 2) or retire the name the way `g.toon.store` was, **before** flipping `g.toon.relay`
to peer forwarding — not as a follow-up. Until #820 lands, this section remains the record that the
live `1` is an accident, not a decision.

## The TypeScript fleet

Both boxes serve the **Rust** connector on the public door — verified by
`GET /ilp/identity` answering, by `invalid packet type byte` (a string that
exists only in `crates/connector-domain/src/error.rs`), and by nginx returning
`410 Gone` for the transitional `/rust/` prefix because Rust took over
`location /`.

The TypeScript `connector.yaml` files remain in the repo but no longer front
traffic. They are not a second source of pricing truth, and the retirement is
tracked in #714. Note `infra/devnet-manage.sh` still deploys the TypeScript
compose files, so running it would resurrect them — see that ticket.
