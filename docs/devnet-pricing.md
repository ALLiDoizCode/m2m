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

| Route                                     | Price    | Fee | Where                                    | Guarded by                             |
| ----------------------------------------- | -------- | --- | ---------------------------------------- | -------------------------------------- |
| apex `g.toon.relay` — terminate, BTP-only | **1**    | —   | `infra/linode-node/connector-rust.toml`  | `EXPECTED_RELAY_PRICE`                 |
| apex `g.toon.ario` — forward to store     | **1002** | 2   | `infra/linode-node/connector-rust.toml`  | `EXPECTED_APEX_FORWARD_PRICE` / `_FEE` |
| store `g.toon.ario` — terminate           | **1000** | —   | `infra/linode-store/connector-rust.toml` | `EXPECTED_STORE_PRICE`                 |
| store `g.toon.relay.ario` — terminate     | **1000** | —   | `infra/linode-store/connector-rust.toml` | `EXPECTED_STORE_PRICE`                 |
| store `announcePrice`                     | **2000** | —   | `infra/linode-store/connector.yaml`      | —                                      |

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

## `announcePrice` 2000

The store's self-announce must cover the apex's `g.toon.relay` terminate price
plus this box's own forward fee, with headroom. It is not a route price and is
not comparable to the figures above.

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
a pricing one. Tracked separately; until then this section is the record that
the `1` is not intentional.

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
