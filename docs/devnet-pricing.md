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

| Route                                                        | Price    | Fee   | Where                                    | Guarded by                                |
| ------------------------------------------------------------ | -------- | ----- | ---------------------------------------- | ----------------------------------------- |
| apex `g.toon.relay` — forward, over the apex↔relay peering\* | **1**    | **0** | `infra/linode-node/connector-rust.toml`  | `EXPECTED_RELAY_FORWARD_PRICE` / `_FEE`   |
| relay `g.toon.relay` — terminate, BTP-only                   | **1**    | —     | `infra/linode-relay/connector-rust.toml` | `EXPECTED_RELAY_PRICE`                    |
| apex `g.toon.ario` — forward to store                        | **1002** | 2     | `infra/linode-node/connector-rust.toml`  | `EXPECTED_APEX_FORWARD_PRICE` / `_FEE`    |
| apex `g.toon.relay.ario` — forward to store                  | **1002** | 2     | `infra/linode-node/connector-rust.toml`  | (repair of the divergence recorded below) |
| store `g.toon.ario` — terminate                              | **1000** | —     | `infra/linode-store/connector-rust.toml` | `EXPECTED_STORE_PRICE`                    |
| store `g.toon.relay.ario` — terminate                        | **1000** | —     | `infra/linode-store/connector-rust.toml` | `EXPECTED_STORE_PRICE`                    |
| store `announcePrice`                                        | **2000** | —     | `infra/linode-store/connector.yaml`      | —                                         |

\* Repo-side only as of #820's own PR. The apex's `transport = "btp"` local terminate route (a
`handler_url` route to `relay:3100`) is what the two LIVE boxes still run today, because the live
peering flip (editing both boxes' untracked `connector-rust.toml`, restarting `connector-rust`, and
walking the peering bring-up gates) is a human step gated on #833 (a client that pays a forwarded
prefix cannot yet learn the terminating connector's identity, so a stock client that follows
discovery for `g.toon.relay` would pay and then be rejected). Do not read the "Verified live" figures
below as reflecting this table until that human step has run.

Last verified live against both boxes (pre-#820, still the live figures as of this writing) via the
unauthenticated `GET /ilp/routes/price?destination=…` (ADR 0022 puts configuration answers on the
free side of the answering/announcing line):

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

## The `g.toon.relay` forward: price/fee split (landed, #820)

The apex's repo-committed config no longer terminates `g.toon.relay` against a co-located
`relay:3100` -- it forwards it over the apex↔relay peering to the relay's own box
(`infra/linode-relay/`, #816/#823/#821), applying ADR 0028's arithmetic: the apex's client edge
charges its own `price`, forwards `price - fee` over the peer wire, and the relay box charges its
own `price` again on arrival. A forward that is short — `apex.price - apex.fee < relay.price` — is
not a subsidy, it is an **F03** on every single write, because ADR 0028 requires `amount == price`
at each hop and #754 makes the terminating side charge its own price against a peer-wire arrival.

**Decided (owner, 2026-08-06): `apex.price = 1, apex.fee = 0`; `relay.price = 1`.** Client cost per
write is unchanged (still 1 µUSDC) and the apex earns nothing for carriage on this leg —
deliberate, not an oversight, and not to be "fixed" by a later reader. `g.toon.relay` carries buzz
huddles at 49 fps (above), so any non-zero apex fee would have required raising `apex.price` above
`relay.price` to keep the arithmetic solvent, which at minimum doubles the per-frame client cost
(1 → 2 µUSDC/frame) for a workload billed per frame, 49 times a second. Zero fee is what keeps that
cost flat while the arithmetic still holds: `1 - 0 = 1 >= 1`.

**`transport = "btp"` moved with the terminating route.** It is only legal alongside `handler_url`
— `ConfigError::PeerRouteHasTransport` refuses it on a `peer_id` route
(`crates/connector-config/src/error.rs:125`) — so the pin the apex carried before #820
(issue #701) is gone from `infra/linode-node/connector-rust.toml` entirely and lives only on
`infra/linode-relay/connector-rust.toml`'s own terminating route now. **The apex therefore lost
client-edge BTP enforcement on this prefix**: once the route is a forward, an HTTP client can reach
the apex's `g.toon.relay` and it is the relay box, not the apex, that refuses it for the wrong
transport.

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

## Resolved divergence: `g.toon.relay.ario` (repaired in #820)

**Historical record — this was live-accidental, not a decision, until #820's repo change.** The Rust
apex config used to declare only `g.toon.relay` and `g.toon.ario`, so longest-prefix matching dropped
`g.toon.relay.ario` into the `g.toon.relay` _terminate_ route — priced 1 and handled by `relay:3100`,
which 404s on a store payload.

The retired TypeScript config called this exact failure out:

> `g.toon.relay.ario` MUST be listed (it is more specific than `g.toon.relay`)
> so longest-prefix routing forwards it to the store box instead of falling
> through to the relay terminate route above (which 404s on /store).

The Rust port dropped the route and reproduced the failure it warned about. Landing #820's
`g.toon.relay` forward without deciding this first would only have relocated the accident, and made
it more expensive: `g.toon.relay.ario` used to 404 for free at the apex's own `relay:3100`; ridden
across the new apex↔relay peering unrepaired, it would have consumed a real signed claim on that
channel only to 404 at the relay box's own `g.toon.relay` terminate route, because the relay box
serves no `.ario` route either (`infra/linode-relay/connector-rust.toml` declares `g.toon.relay`
alone).

**Repaired, not retired.** `connector-config` has no route shape that declares a prefix
"unroutable" — every `[[routes]]` entry needs either `handler_url` or `peer_id`
(`ConfigError::RouteMissingTarget`) — so retiring the name the way `g.toon.store` was could not be
done by simply omitting an entry; `g.toon.relay.ario` now has its own `[[routes]]` entry in
`infra/linode-node/connector-rust.toml`, `peer_id = "apex-store"`, mirroring `g.toon.ario` at the
identical 1002/fee 2, since it reaches the exact same store app the store box already terminates it
at (`price = 1000`). **Nothing in a shipped client is affected either way** — buzz pins
`storeDestination: "g.toon.ario"` in compiled code, never the relay-hop spelling.

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
