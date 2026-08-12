# The local stack

A deployment rehearsal on one machine: the Rust connector, the real published
relay, a local `anvil` carrying the settlement topology — and, at the end, the
real `rig` CLI cloning for free and writing for money against all of it.

**LOCAL / DEV ONLY.** `infra/linode-*` owns devnet; nothing here is deployed,
published or SSH'd anywhere, and every key in this directory is a test fixture.

```
payer  ──POST /ilp──▶ connector ──POST /write──▶ relay:3100   PAID, private
reader ──ws REQ ────────────────────────────────▶ relay:7100   FREE, published
```

## Bring it up

```sh
# 1. a local chain with the settlement topology deployed, on 127.0.0.1:8545
# 2. anvil binds loopback only, which host-gateway cannot reach:
python3 deploy/connector-rust/local-stack/rpcproxy.py 172.17.0.1 8546
# 3. images + throwaway keys
docker build -f deploy/connector-rust/Dockerfile -t connector-rust:local .
docker pull ghcr.io/toon-protocol/relay:sha-a8693a9
deploy/connector-rust/local-stack/prepare.sh
docker compose -f deploy/connector-rust/local-stack/docker-compose.local.yml up -d
```

## Prove it

```sh
REHEARSAL_EDGE=http://127.0.0.1:3000 \
REHEARSAL_RPC=http://127.0.0.1:8545 \
REHEARSAL_REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
REHEARSAL_TOKEN=0x5FbDB2315678afecb367f032d93F642f64180aa3 \
  cargo test -p connector --test local_stack_rehearsal -- --nocapture
```

`crates/connector-bin/tests/local_stack_rehearsal.rs` is inert without those,
so an ordinary `cargo test` never needs a live stack.

## The rig loop

`rig` finds a connector exactly one way: a kind:10032 announce on a relay it
already knows (`toon-client` `packages/rig/src/cli/standalone-mode.ts`). Per
ADR 0022 the connector does not publish that — "answering is not announcing";
discovery is the controller's business and lives outside the connector (ADR
0006). The operator publishes it, which is what `publish-announces.mjs` is.

Note that publishing it is a **paid** write, not a free WebSocket publish: the
relay declines every WS `EVENT` with `restricted: writes require ILP payment`
regardless of `TOON_OBLIVIOUS_MODE`. Reads are free; writes are not, discovery
events included.

```sh
# once: build toon-client (it supplies the sealed wire and core's own
# kind:10032 builder, so the announce is shaped by the code that parses it)
cd <toon-client> && pnpm install && pnpm -r build

# publish the kind:10032 connector announce + a kind:30617 repo announcement
TOON_CLIENT=<toon-client> \
  node deploy/connector-rust/local-stack/publish-announces.mjs

# FREE: clone the announced repo straight off the relay — no payment, no
# channel, no identity. Prints the owner pubkey to use here.
node <toon-client>/packages/rig/dist/cli/rig.js \
  clone ws://127.0.0.1:7100 <owner-hex>/local-rehearsal demo

# PAID: rig resolves the connector from the kind:10032 announce, opens a real
# channel on the local chain, seals a packet and lands an event.
cd demo
RIG_STANDALONE=1 RIG_TOPOLOGY_TTL_MS=0 \
RIG_MNEMONIC="test test test test test test test test test test test junk" \
TOON_GENESIS_PEERS='[{"pubkey":"<announcer>","relayUrl":"ws://127.0.0.1:7100","ilpAddress":"g.local.relay","btpEndpoint":"ws://127.0.0.1:3000"}]' \
  node <toon-client>/packages/rig/dist/cli/rig.js issue create \
    --title "a paid write from rig" --body "…" --yes

# FREE again: read it back
node <toon-client>/packages/rig/dist/cli/rig.js issue list
```

`TOON_GENESIS_PEERS` is what keeps the run local: without it rig's baked
genesis seed sends bootstrap to the devnet relay. rig's settlement wallet
(`rig identity show`) needs gas and USDC on the local chain before the first
paid write — it opens a real payment channel.

### Operator notice (toon#183)

`publish-announces.mjs` sets `IlpPeerInfo.notice` on the announce's schema
field — never merged into the `content` ride-along block — when `NOTICE_ID`,
`NOTICE_SUMMARY` and `NOTICE_URL` are all set (`NOTICE_SEVERITY` is optional,
`info` or `action-required`, defaulting to `info`). Configuration only: the
script never composes a notice. Leave all four unset for the common case — no
`notice` key at all, byte-identical to today.
