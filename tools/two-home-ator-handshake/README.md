# Two-Home ATOR Handshake

Operator-facing script that walks two laptops, in two different homes, through:

1. Standing up an ILP connector with a managed ATOR (Anyone Protocol) hidden service
2. Exchanging `.anon` peer URLs and a shared BTP auth token out-of-band
3. Verifying end-to-end ILP packet delivery over the ATOR overlay

Wraps shipped Epic 35 components (`SocksTransportProvider`, `ManagedAnonClient`, `socks5h://` DNS-leak prevention, fail-closed startup, hidden-service auto-resolution). It is **not** a substitute for the planned Epic 42 acceptance test — it is a guided runner that lets two operators reproduce the scenario today.

## Prerequisites

On **both** laptops:

- Linux or macOS (WSL works)
- Node.js >= 22.11.0, npm >= 10
- This repo cloned and built (`npm install && npm run build`)
- The optional ATOR SDK installed:
  ```bash
  npm install @anyone-protocol/anyone-client@^1.1.3 --workspace=packages/connector
  ```
- `openssl` (preferred) or any working node install
- A side channel to exchange a URL + token (Signal, encrypted email, in person)

The script prints actionable errors via `preflight` if anything is missing.

## The choreography

Run on **each** laptop separately. Pick distinct `<node-id>`s — e.g. Alice picks `alice-laptop`, Bob picks `bob-laptop`.

```bash
cd <repo-root>
./tools/two-home-ator-handshake/handshake.sh preflight
./tools/two-home-ator-handshake/handshake.sh init alice-laptop      # Bob: bob-laptop
./tools/two-home-ator-handshake/handshake.sh start --detach
./tools/two-home-ator-handshake/handshake.sh share                  # waits for HS, then prints URL
```

`share` outputs something like:

```
  Node ID:   alice-laptop
  Peer URL:  wss://abcd1234efgh5678.anon:443
```

### Out-of-band exchange (the only manual step)

Both operators send each other their **Peer URL** from `share` (over Signal / encrypted email / in person).

### BTP auth: pick a mode

The TOON network is **permissionless by default** at the BTP transport layer — access control happens at the ILP layer (routes, settlement, credit limits). You have two choices:

**Permissionless (default, simpler):** skip `--auth-token`. BTP accepts any handshake from the configured peer ID; no shared secret needed.

```bash
# Alice
./tools/two-home-ator-handshake/handshake.sh add-peer \
    bob-laptop wss://wxyz5678abcd1234.anon:443
# Bob
./tools/two-home-ator-handshake/handshake.sh add-peer \
    alice-laptop wss://abcd1234efgh5678.anon:443
```

**Permissioned (opt-in, hardened):** one operator generates a shared token; both use the _same_ value:

```bash
openssl rand -hex 32
# e.g. 4a8c1d9e2f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c

# Alice
./tools/two-home-ator-handshake/handshake.sh add-peer \
    bob-laptop wss://wxyz5678abcd1234.anon:443 \
    --auth-token 4a8c1d9e2f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c

# Bob (same token)
./tools/two-home-ator-handshake/handshake.sh add-peer \
    alice-laptop wss://abcd1234efgh5678.anon:443 \
    --auth-token 4a8c1d9e2f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c
```

Either way, `add-peer` writes the peer + a default route `g.<peer-id>.* -> <peer-id>` into the local config. **Restart the connector** for the new peer to take effect:

```bash
./tools/two-home-ator-handshake/handshake.sh stop
./tools/two-home-ator-handshake/handshake.sh start --detach
```

### Verify

On either laptop:

```bash
./tools/two-home-ator-handshake/handshake.sh doctor
```

`doctor` runs `health` → `peers` → `ping <first-peer>` and reports the round-trip. Expected outcomes:

| Outcome             | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `FULFILL`           | Full ILP loop works (peer has a handler that accepts the packet).                                            |
| `REJECT` round-trip | ATOR circuit + BTP link work; peer just rejected the test packet. **This still proves transport readiness.** |
| `Timeout (408)`     | Peer unreachable over ATOR. Run `health` and `peers` on both sides; check `connector.log`.                   |

## What "ready" actually means after a green run

A green `doctor` on two laptops in two homes proves, for that pair:

- Each side's managed `anon` boots, builds a circuit, and publishes a hidden service
- Outbound BTP through a fresh `SocksProxyAgent` per connect actually reaches `<peer>.anon:443`
- BTP auth handshake completes through the rendezvous circuit
- An ILP `PREPARE` round-trips through the overlay and a response makes it back

It does **not** prove:

- Sustained throughput, circuit-rebuild resilience, multi-day uptime (Epic 42 work)
- Settlement on chain — `chainProviders` is intentionally omitted from the generated config
- That a third laptop in a third home would also work without configuration changes (it should — but you've only proved one pair)

## State directory

Default: `<repo-root>/two-home-state/` (override with `--state-dir`). Layout:

```
two-home-state/
├── connector.yaml          # generated; chmod 600
├── admin-api-key           # 32-byte hex; chmod 600
├── node-id                 # plaintext
├── hidden-service/
│   └── hostname            # written by managed anon at first start
├── connector.pid           # only when started with --detach
└── connector.log           # only when started with --detach
```

## Subcommand reference

| Command                                               | What it does                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preflight`                                           | Node version, build artifacts, optional anon SDK, port availability                                                                                                                                                                                    |
| `init <node-id>`                                      | Generates `connector.yaml` with `transport.type: socks5`, `externalUrl: auto`, managed mode                                                                                                                                                            |
| `start [--detach]`                                    | Boots the connector. Auto-exports `BTP_PEER_<ID>_SECRET` env vars from any permissioned peers in YAML, plus `BTP_ALLOW_NOAUTH=false` if any peer opts into auth. Foreground by default; `--detach` writes `connector.pid` and tails to `connector.log` |
| `share`                                               | Waits for `hidden-service/hostname`, prints `wss://X.anon:443` + node-id                                                                                                                                                                               |
| `add-peer <id> <url> [--auth-token TOK] [--chain ID]` | Appends a peer entry + default route. Token is optional — omit for permissionless BTP, supply for permissioned. Restart required                                                                                                                       |
| `health`                                              | `GET /health`; reports `transport.healthy`                                                                                                                                                                                                             |
| `peers`                                               | `GET /admin/peers`; shows BTP connection state                                                                                                                                                                                                         |
| `ping <peer-id> [--amount N]`                         | `POST /admin/ilp/send` with `g.<peer-id>.handshake-ping`, reports round-trip                                                                                                                                                                           |
| `doctor`                                              | `health` + `peers` + `ping` against the first configured peer                                                                                                                                                                                          |
| `stop`                                                | SIGTERM the detached connector, SIGKILL after 15s grace                                                                                                                                                                                                |
| `teardown`                                            | Removes the state dir (asks first)                                                                                                                                                                                                                     |

Global flags: `--state-dir <dir>`, `--verbose`.

## BTP auth model — why the script handles both sides

The connector's BTP layer has an asymmetric auth model that's easy to trip over if you only read the YAML schema:

- **Outbound** (when this connector connects to a peer): `peers[].authToken` from the YAML is sent in the BTP handshake (`packages/connector/src/btp/btp-client.ts:330`).
- **Inbound** (when a peer connects to this connector): the BTP server validates the inbound secret against `process.env.BTP_PEER_<ID>_SECRET` — **not** the YAML — per `packages/connector/src/btp/btp-server.ts:573-588`. If a peer presents a non-empty secret and no env var is set, the connection is rejected with F00 "peer not configured".
- **Empty-string secrets** are accepted by default unless `BTP_ALLOW_NOAUTH=false` is set (`btp-server.ts:519-538`). This is the documented permissionless mode for ILP-gated networks.

`start` reads the YAML and:

1. For each peer with a non-empty `authToken`, exports `BTP_PEER_<peer-id-uppercased-with-underscores>_SECRET=<token>` so inbound auth works.
2. If any peer has a non-empty token, also exports `BTP_ALLOW_NOAUTH=false` — once you've opted into auth for one peer, empty-string handshakes from anyone else get rejected.

You don't need to manage these env vars manually; `start` reports the mode it's running in.

## Troubleshooting

- **`@anyone-protocol/anyone-client (optional dep) is NOT installed`** — that SDK manages the `anon` binary; managed mode requires it. Install with the command in `preflight`'s output.
- **Hidden service hostname not written after 120s** — circuit build is slow on first run. Tail `connector.log` for `managed_anon_started` and `hidden_service_published` events. If you see `managed_anon_crash_detected`, the bundled `anon` binary likely couldn't bind the SOCKS port — check whether system `tor` is already on `:9050`.
- **`transport.healthy = false`** — the 30s background TCP probe to the SOCKS port is failing. The connector keeps running but outbound peering won't work. Restart `anon` (re-run `start`).
- **`Timeout (408)` on ping** — the peer's hidden service isn't reachable. Have both sides run `health` and confirm `transport.healthy: true`. Confirm the URL and shared token match exactly.
- **`REJECT` with code `F02 Unreachable`** — the peer is reachable over ATOR but doesn't have a route for `g.<your-id>.*`. That still proves the ATOR + BTP loop. To get `FULFILL`, the peer needs a local delivery handler registered (see `docs/ator-transport.md` and the `localDelivery` config block).

## Single-machine Docker verification (no second laptop required)

If you want to verify the scenario end-to-end **without** standing up a second physical laptop, two Docker-based topologies are wired up. Both use real `anon` binaries and real circuit + HS rendezvous; the differences are network and offline/online.

### Option B — two-home over LOCAL ATOR testnet (offline, fast)

Uses the local ATOR testnet from `make ator-up` (3 DirAuths + 4 relays + 1 HS). Two new sidecar containers join `ator_net` so they reach relay descriptors at the testnet's internal bridge IPs — sidesteps the host-side blocker documented at `packages/connector/test/integration/standalone-ator-hs-local-e2e.test.ts:47-76`.

```bash
make ator-up                      # local testnet (DirAuths + relays + shared volume)
make two-home-ator-local-up       # 2x sidecar + 2x bls + 2x connector containers
make two-home-ator-local-verify   # waits for HS, registers peers, sends test packet
make two-home-ator-local-down
make ator-down
```

Wall-clock: HS publish ~30-90s per side, BTP connect ~5-15s, packet round-trip <2s. A green run confirms: real anon binary, real testnet circuit, real HS rendezvous, real BTP, real ILP packet flow at the BLS.

What it does **not** prove: the home-NAT NAT-traversal claim. Containers don't have NAT in the home-router sense.

### Option A — two-home over PUBLIC ATOR (online, highest fidelity)

Already shipped as the `standalone-ator-p2p` profile + `standalone-ator-public-p2p-container-e2e.test.ts`. Two `anon` sidecars on the **public** Anyone network, each hosting a hidden service for the adjacent connector container.

```bash
make standalone-test-ator-p2p     # builds + brings up + runs test, ~3-7 min
```

Requires outbound internet. Slow and flaky by nature (public network); nightly-dispatch only — do **not** add to PR CI. This is the closest CI-runnable analog to the Epic 42 acceptance gate.

### How to choose

| Need                                                                        | Use                                           |
| --------------------------------------------------------------------------- | --------------------------------------------- |
| "Does the code work?" — fast offline check                                  | Option B                                      |
| "Does it work over the real public network?" — release verification         | Option A                                      |
| "Does it work in two homes behind home routers?" — the actual product claim | Two physical laptops + `handshake.sh` (above) |

## Honest scope

This is a verification aid, not a CI gate. The shipped components are individually tested (see `packages/connector/test/integration/transport-*.test.ts` and the nightly `transport-ator-real-binary.test.ts` against pinned `anon v0.4.10.0-beta`), but the canonical "two-machine, two-network, real ATOR" gate lives in the planned Epic 42 acceptance test (`acceptance.home-hosting.spec.ts` — not yet built; tracked in `_bmad-output/planning-artifacts/epic-42-home-hosting-acceptance-e2e.md`).

A green `doctor` on two laptops in two homes — or a green `make two-home-ator-local-verify` in Docker — is real-world evidence. Keep the output and timestamp it.
