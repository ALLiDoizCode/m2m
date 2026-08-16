# connector-rust — build and run

The Rust connector (ADR 0001) as a container image: one static binary, one
config file, no JavaScript runtime. This is the complete, no-undocumented-steps
path from a clone of this repository to a running node answering `POST /ilp`
and an authenticated `GET /metrics`.

All commands below run from the repository root.

## Pulling the published image

`.github/workflows/publish-connector-rust-image.yml` publishes this image to
`ghcr.io/toon-protocol/connector` on every push to `main` that touches
`crates/**`, `Cargo.toml`/`Cargo.lock`, `packages/solana-program/**`, or this
Dockerfile (also runnable manually via `workflow_dispatch`). The package is
public, so no registry login is required to pull it.

It shares the `connector` package with the retired TypeScript node (last tag
`4.0.0`, no longer published); the `rust-` tag prefix keeps the two disjoint.
This is a reversal of #487's original `connector-rust` package — see the
workflow header for why the Rust binary reclaimed the canonical name.

Tags:

| Tag                    | Meaning                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rust-sha-<short-sha>` | Immutable — pins the exact commit the binary was built from. Use this for any deployment that needs a reproducible pin (e.g. #490's devnet overlay).                                                                                                                                   |
| `rust-main`            | Floating — always the most recent build off `main`. Convenience only; do not pin a deployment to it.                                                                                                                                                                                   |
| `rust-release`         | Floating — same content as `rust-main` (moves on every green push to `main`). This is the tag a box's label-scoped Watchtower would follow under toon-meta#403's fleet-wide `:release` convention; no box is wired to it yet (connector#989) — that repoint is a separate, gated step. |

There is no semver tag series here: no crate under `crates/` has a release
process yet, and inventing one for the image alone would claim a stability
contract the binary hasn't earned. Compare
[`CONNECTOR_RELEASE_CONTRACT.md`](../../CONNECTOR_RELEASE_CONTRACT.md), which
describes the semver/cosign contract the old TypeScript image had — that
image is no longer published (4.0.0), and this one does not (yet) carry an
equivalent contract.

```bash
docker pull ghcr.io/toon-protocol/connector:rust-sha-<short-sha>
```

For a **whole stack** on one machine rather than a single node — connector,
relay, a local `anvil` carrying the settlement topology, and a real paid write
plus on-chain redeem end to end — see
[`local-stack/README.md`](local-stack/README.md). That is a rehearsal, not a
deployment: nothing in it is published or pinned, and every key in it is a test
fixture.

Skip to [step 6](#6-run-it) to run it — the config/key setup in steps 1-4
below is identical whether you built the image locally or pulled it.

## 1. Generate a signer key

The connector signs claims and settlement transactions with this key
(ADR 0012). `key_file` accepts either 32 raw bytes or 64 hex characters:

```bash
openssl rand -hex 32 > deploy/connector-rust/signer.key
chmod 600 deploy/connector-rust/signer.key
chown 10001:10001 deploy/connector-rust/signer.key   # see below
```

The image runs as `connector` (uid/gid **10001**, set by the Dockerfile's
`adduser -D -u 10001` / `USER connector`), and a bind-mounted file keeps its
_host_ ownership inside the container -- a `:ro` mount does not make it
readable. So a key written by root at the natural `0600` is unreadable to the
process that needs it, and the container restart-loops on:

```text
failed to read signer key_file at /app/data/signer.key: Permission denied (os error 13)
```

which is what happened deploying the devnet apex in #492. `chown 10001:10001`
fixes it without widening the mode. Do not reach for `chmod 644` instead:
this is the key the connector signs claims and settlement transactions with
(ADR 0012), and it should stay readable by exactly one uid.

This applies to the key file wherever it lives, under whatever name. The
devnet overlays under `infra/linode-store/` and `infra/linode-relay/` mount
`./signer-rust.key` rather than this directory's `signer.key` -- same
generation, same `chmod`, same `chown`, different path:

```bash
openssl rand -hex 32 > infra/linode-store/signer-rust.key
chmod 600 infra/linode-store/signer-rust.key
chown 10001:10001 infra/linode-store/signer-rust.key
```

## 2. Generate an operator bearer token

Every read on the operator surface (peers, routes, channels, claims,
exposure, identity, the audit log, and `GET /metrics`) requires this token
(ADR 0008):

```bash
openssl rand -hex 32
```

Paste the output into `deploy/connector-rust/connector.toml`'s
`operator.bearer_token`, replacing the `CHANGE-ME-...` placeholder.

## 3. Generate an operator write key

Every write (currently `POST /packets`) requires an RFC 9421 signature from
an ed25519 key on this allowlist -- no bearer token is ever sufficient to
move value. Generate a key pair and extract its raw 32-byte public key as
64 hex characters:

```bash
openssl genpkey -algorithm ed25519 -out deploy/connector-rust/operator.pem
openssl pkey -in deploy/connector-rust/operator.pem -pubout -outform DER \
  | tail -c 32 | od -An -tx1 | tr -d ' \n'
```

Paste that hex string into `connector.toml`'s `operator.write_keys` array,
replacing the placeholder (which is deliberately not 64 hex characters, so
the file refuses to load until you do this). Keep `operator.pem` -- it is
the private key an operator client signs writes with; nothing in this
directory reads it automatically.

## 4. Edit the route(s)

`connector.toml`'s `[[routes]]` block points at an example app
(`http://app:3100`). Replace `prefix` and `handler_url` with your own app's
ILP address and handler URL, or delete the block if this node only peers.
`price` is required on a terminated route — write `price = 0` if free is
deliberate, because it is never silently free.

To peer, set `peer_expose` (which peer carriages this node accepts _peer_
traffic on — it opens no port, and a node that leaves it at its `neither`
default still serves clients over BTP exactly as before), add a `[[peers]]`
entry with a `wss://` or `https://` `endpoint` and a `credential`, a
`[[peer_channels]]` row binding it to a channel, and a
`[[routes]]` entry that names the peer's `id` instead of a `handler_url`.
The template's commented peering block annotates every field. ADR 0027
deleted the raw-TCP peer wire that preceded this (issue #679), along with
`peer_wire_addr` and the `SocketAddr`-shaped `[[peers]].addr`; a config
still setting either now fails config load by name.

Write the credential as a **`secret_file`**, not a literal:

```toml
credential = { secret_file = "/app/data/store-peer.secret" }
```

```sh
openssl rand -hex 32 > /app/data/store-peer.secret   # both sides need the same bytes
chmod 600 /app/data/store-peer.secret
```

That keeps the peering itself in a config you can commit while the secret
stays on the box — the same shape `[signer] key_file` and the settlement
keys already use, and `deploy/connector-rust/*.secret` is gitignored for it.
The path is resolved the way `key_file` is, so make it absolute and make it
a path _inside_ the container. It is read at startup and trimmed of trailing
whitespace; missing, unreadable or empty stops the node by name
(`PeerSecretFileNotFound` / `PeerSecretFileUnreadable` /
`PeerSecretFileEmpty`). A literal `secret` still works and is fine for a
config nobody commits; setting both is `PeerCredentialAmbiguous`.

Two things to get right, both of which fail silently rather than loudly:

- **`[[peers]].id` is one string both operators write.** It is the `peerId`
  the dialing side presents, and the accepting side proves it against its
  own `[[peers]]` table — so an id the far side does not have is admitted
  as an ordinary client, with nothing in the log.
- **There is no peer port.** A peer's `endpoint` is
  `wss://<host>/ilp/btp` or `https://<host>/ilp` — this node's own client
  edge — because peer carriages ride the listener it already serves and
  role is decided by the credential, not by the port. Those are the same
  two URLs an ordinary client uses, and a client uses them **without a
  credential**: `GET /ilp/btp` accepts a session that presents none (or an
  empty `secret`) and keeps it a client, and what pays for a write is the
  signed claim on each frame, never the session
  (`docs/protocol/client-edge-spec.md` §1.9 step 1). The `credential` here
  buys peer role, not entry.

A packet routed to a peer this node cannot dial is still answered
`T01 peer unreachable`, never dropped. See
`docs/operators/btp-peer-transport-bringup.md`.

## 4b. (Optional) settlement

Omit `[settlement]` entirely and the node routes and charges normally, but
every channel operation on the operator surface answers `503` — there is no
backend to run it. Configure it and the node resolves the
`TokenNetworkRegistry` at `contract_address` **at startup**, so a wrong RPC
URL or a registry that does not answer `getTokenNetwork(token)` is an
exit-1, not a runtime surprise. Only `chain = "evm"` is accepted today.

`infra/linode-store/connector-rust.toml` carries a commented, annotated
`[settlement]` block to copy from; `crates/connector-bin/tests/devnet_configs_load.rs`
boots exactly that block against a freshly deployed registry on anvil, so it
is a template that is known to load.

## 4c. Durable claim state

`connector.toml` sets `state_dir = "/app/state"`. That directory holds the
append-only claim journals — `client-edge-claims.log` and `peer-claims.log` —
whose replay is what makes a claim's **replay watermark** survive a restart.
Without it the watermarks live only in process memory: a restart resets every
channel to "no claim ever seen", and a channel with no watermark accepts any
nonce, so every claim a client has already spent becomes free service again
(issue #605).

It must be a **volume**, not a path inside the container's writable layer — a
watermark that dies with the container is the same defect one indirection
down. The image runs as uid `10001`, and it ships `/app/state` already owned
by that uid — that pre-existing path is what a fresh **named volume** inherits
its ownership from on first mount, so a named volume needs no manual `chown`.
(An image built before this path existed initializes the volume root-owned
instead, and the node refuses to start on it.) A host bind mount inherits
nothing: `chown 10001:10001` it first, exactly like `signer.key` in step 1.

Two things fail closed here rather than degrading quietly:

- a config with `[[client_channels]]` but no `state_dir` **does not load**;
- a `state_dir` the node cannot write, or a journal it cannot replay (a
  corrupt line), is an **exit 1 at startup**, naming the path.

## 5. Build the image

```bash
docker build -f deploy/connector-rust/Dockerfile -t connector-rust:local .
```

For both target platforms:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f deploy/connector-rust/Dockerfile -t connector-rust:local .
```

## 6. Run it

```bash
docker run --rm \
  -p 3000:3000 \
  -v "$(pwd)/deploy/connector-rust/connector.toml:/app/config/connector.toml:ro" \
  -v "$(pwd)/deploy/connector-rust/signer.key:/app/data/signer.key:ro" \
  -v connector_rust_state:/app/state \
  connector-rust:local
```

(The image's `CMD` already points at `/app/config/connector.toml` --
nothing more to pass on the command line.)

`-v connector_rust_state:/app/state` is the `state_dir` from step 4c. Drop it
and the node still starts, but every claim watermark it holds dies with the
container — which is the whole of issue #605. In a compose file the equivalent
is a `connector_rust_state:/app/state` entry under `volumes:` for the service,
plus a top-level `volumes: { connector_rust_state: }` — see
`infra/linode-store/docker-compose.store.rust.yml`.

## 7. Verify

```bash
# The client edge answered (400: an empty body isn't a valid PREPARE).
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/ilp

# The identity a sender seals a packet's payload to (ADR 0018).
curl -s http://localhost:3000/ilp/identity
# → {"keyId":"...","publicKey":"0x04..."}

# The price of the route you configured in step 4 (404 if nothing matches).
curl -s 'http://localhost:3000/ilp/routes/price?destination=g.example.connector.app'
# → {"destination":"g.example.connector.app","price":100}

# The operator surface requires the token you generated in step 2. It shares
# this one port -- there is no separate admin port, and no health endpoint.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/metrics        # 401
curl -s http://localhost:3000/metrics -H "Authorization: Bearer <token-from-step-2>"
```

The last command prints the decided metrics surface (ADR 0014):
`toon_packets_total`, `toon_packets_rejected_total`, `toon_fees_earned_total`,
`toon_exposure` and `toon_settlement_total`.

## Logs

The connector logs structured JSON (one object per line) to stdout. Every
line logged while handling a packet -- received, routed, delivered or
forwarded, fulfilled or rejected -- carries the same `correlation_id`: the
packet's execution condition, hex-encoded. Because that condition is
invariant across every hop a packet passes through, the same
`correlation_id` appears in the logs of every connector that handled the
packet, so `jq 'select(.fields.correlation_id == "...")'` against either
node's log stream (or both, once aggregated) recovers that packet's whole
path. Set `RUST_LOG` (e.g. `RUST_LOG=debug`) to change verbosity; it is not
a config file field (ADR 0009 has no environment-variable layer for
anything the connector's _behavior_ depends on, but log verbosity is an
operational knob, not a behavioral one).
