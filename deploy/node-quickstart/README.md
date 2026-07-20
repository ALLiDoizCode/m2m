# node-quickstart — run a TOON relay node and join the network

The **nginx moment** for TOON: one `docker compose up`, a seedphrase, and you have a
paid Nostr relay behind a TOON connector, pointed at the live public devnet (Base Sepolia).

```
payer  ──POST /ilp (3000)──▶  connector (g.proxy) ──▶ relay (g.proxy.relay)   [paid write]
reader ─────────────────  free NIP-01 WS  ─────────────▶ relay                [free read]
```

This bundle is self-contained (compose + config + `.env` + verify script), modelled on
[`../pay-edge/`](../pay-edge/). It pulls the **published** connector and relay images — you do
not need the relay repo checked out. For the full narrative (pick a node, peer, put your own app
behind TOON) see **[toon-meta `docs/node-operator-guide.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/node-operator-guide.md)**; this README is the runnable half it leans on.

## Prerequisites

- Docker + Docker Compose v2.
- Nothing else for a first run — the default config **boots** against the live public devnet
  (Base Sepolia) with an unfunded default key: enough to serve free reads + the operator
  dashboard. To complete a **paid** write you set `TOON_MNEMONIC` and fund it (step 3).

## 1. Run one node

```bash
cp .env.example .env          # optional for a first run; edit to add your mnemonic
docker compose up -d
./verify.sh                   # smoke-check health + dashboard + metrics
```

`verify.sh` confirms `GET /health`, the operator dashboard, and `/admin/metrics.json` respond.

**Free read** — the relay's Nostr WS speaks NIP-01 and never touches the payment path. It is not
published by default (only reachable as `relay:7100` on the compose network); to serve public reads,
front it with TLS the way [`../pay-edge/docker-compose.caddy.yml`](../pay-edge/docker-compose.caddy.yml) fronts the connector.

## 2. Open the operator dashboard

```
http://127.0.0.1:8081/admin/dashboard
```

Live throughput, reject rate, estimated fee earnings, per-peer activity, and node health — polled
from the connector's own `/admin/metrics.json` (1 Hz) and `/admin/earnings.json`. It is served from
the admin API, so it inherits the same IP allowlist; the default `172.16.0.0/12` range covers a
host request arriving through the docker bridge. No external services, no build step.

## 3. Use your own settlement identity

The default `keyId` boots but is **unfunded** on Base Sepolia. To settle as **you**:

1. Set `TOON_MNEMONIC` in `.env` and fund it at <https://faucet.devnet.toonprotocol.dev>.
2. `docker compose up -d` and read the boot log line `settlement address: 0x…`.
3. Put that address in `connector.yaml` → `routes[].settlementAddresses.evm` (payers open their
   channel toward it). This coupling is manual today — see
   [`docs/dx-findings.md` A3](https://github.com/toon-protocol/toon-meta/blob/main/docs/dx-findings.md).

## 4. Peer with a neighbour

```bash
docker compose --profile peer up -d
./verify.sh --peer
# Verify from the DIALER (node B, :8083) — it lists the peer it opened:
curl -s http://127.0.0.1:8083/admin/peers | jq   # → g.proxy, connected: true
```

`--profile peer` starts a **second** connector+relay (`-peer`, node `g.peer`) that dials node A over
BTP (`ws://connector:3000`) and installs a static route to `g.proxy`. A write addressed to
`g.proxy.relay` sent to **node B** (`127.0.0.1:3001`) is forwarded across the peer link to node A and
delivered to node A's relay — cross-node routing, on one machine.

> **Which side to check.** `/admin/peers` lists a node's **outbound** (client) peers — the sessions
> it dialed. So the link shows on **node B** (`:8083`), the dialer. Node A (the dialee) accepts the
> inbound session at its BTP server but does **not** surface it in `/admin/peers`; confirm node A's
> side in its logs instead: `docker compose logs connector | grep btp_auth` →
> `peerId":"g.peer","success":true`.

The peer YAML schema is the thing to learn here (`connector-peer.yaml`):

| Field                         | Meaning                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `peers[].id`                  | the neighbour's node id (its apex, e.g. `g.proxy`)                                    |
| `peers[].url`                 | its BTP endpoint (`ws://host:3000`)                                                   |
| `peers[].relation`            | `peer` (settle bilaterally) · `child` (free-forward, settled in aggregate) · `parent` |
| `routes[].prefix` → `nextHop` | send anything under `prefix` to the peer id `nextHop`                                 |

**Discovered vs peered.** Reading a neighbour's `kind:10032` announce off a relay is _free discovery_;
it does not open a channel. **Peering** = funding a bilateral channel, a deliberate capital decision
(`autoRegister` is off by design). For the automatic, Nostr-native version of this — link-state route
learning over `kind:10032` — and the design for _owning a global name_, see the
[peering & naming RFC](https://github.com/toon-protocol/toon-meta/blob/main/docs/rfc-peering-naming.md).

**Restart-order footgun.** A BTP client gives up after ~5 retries (~60 s). If you restart node A,
also `docker compose restart connector-peer` so node B re-dials.

> The default single-node profile keeps node A's `peers: []` empty, so a plain `docker compose up`
> produces no BTP reconnect noise. The `peer` profile demonstrates the B→A direction; for full
> bidirectional peering, add a mirror `peers[]`/`routes[]` pair to `connector.yaml`, exactly like
> `scripts/standalone-e2e/peer1.yaml` and `peer2.yaml`.

## 5. Prove a paid write

A payer is **not** plain `curl` — a write is an ILP PREPARE (the TOON-encoded event) plus a signed
channel claim, over ILP-over-HTTP (`POST /ilp`). Use a real client:

- **`rig`** (git-native CLI): `npm i -g @toon-protocol/rig`, then follow the
  [rig README](https://github.com/toon-protocol/toon-client/blob/main/packages/rig/README.md)
  (identity → fund → push), pointing it at `http://127.0.0.1:3000/ilp`.
- **The in-repo prover:** `scripts/standalone-e2e` / `deploy/pay-edge/prove-roundtrip.ts` is the
  reference payer used by the paid round-trip harness.

## 6. Put your own app behind TOON (proxy path)

Want to monetize an existing HTTP service instead of running a relay? That's the payment-proxy path:
[`../pay-edge/`](../pay-edge/) drops the connector in front of any payment-oblivious HTTP backend
(the connector README's ["Writing Your Own App"](../../README.md) documents the `POST /handle-packet`
/ `GET /health` contract). Same connector image, a different `route.upstream`.

## What's not here yet

- **Store (Arweave DVM) node.** The `store` image exists, but its paid round-trip is currently
  blocked by a connector↔SDK payload-format skew
  ([`docs/handoff-arweave-dvm-deploy.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/handoff-arweave-dvm-deploy.md)).
  A `store` service will be added to this bundle once that lands.
- **Pinned image digests.** Defaults are `:latest`; pin a digest in `.env` (`CONNECTOR_IMAGE`,
  `RELAY_IMAGE`) for reproducible deployments.
