# connector-rust — build and run

The Rust connector (ADR 0001) as a container image: one static binary, one
config file, no JavaScript runtime. This is the complete, no-undocumented-steps
path from a clone of this repository to a running node answering `POST /ilp`
and an authenticated `GET /metrics`.

All commands below run from the repository root.

## Pulling the published image

`.github/workflows/publish-connector-rust-image.yml` publishes this image to
`ghcr.io/toon-protocol/connector-rust` on every push to `main` that touches
`crates/**`, `Cargo.toml`/`Cargo.lock`, `packages/solana-program/**`, or this
Dockerfile (also runnable manually via `workflow_dispatch`). It is a
**separate image from `ghcr.io/toon-protocol/connector`** — see the Dockerfile
header for why — and the package is public, so no registry login is required
to pull it.

Tags:

| Tag               | Meaning                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sha-<short-sha>` | Immutable — pins the exact commit the binary was built from. Use this for any deployment that needs a reproducible pin (e.g. #490's devnet overlay). |
| `main`            | Floating — always the most recent build off `main`. Convenience only; do not pin a deployment to it.                                                 |

There is no semver tag series here: no crate under `crates/` has a release
process yet, and inventing one for the image alone would claim a stability
contract the binary hasn't earned. Compare
[`CONNECTOR_RELEASE_CONTRACT.md`](../../CONNECTOR_RELEASE_CONTRACT.md), which
describes the semver/cosign contract the old TypeScript image had — that
image is no longer published (4.0.0), and this one does not (yet) carry an
equivalent contract.

```bash
docker pull ghcr.io/toon-protocol/connector-rust:sha-<short-sha>
```

Skip to [step 6](#6-run-it) to run it — the config/key setup in steps 1-4
below is identical whether you built the image locally or pulled it.

## 1. Generate a signer key

The connector signs claims and settlement transactions with this key
(ADR 0012). `key_file` accepts either 32 raw bytes or 64 hex characters:

```bash
openssl rand -hex 32 > deploy/connector-rust/signer.key
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
  connector-rust:local
```

(The image's `CMD` already points at `/app/config/connector.toml` --
nothing more to pass on the command line.)

## 7. Verify

```bash
# The client edge answered (400: an empty body isn't a valid PREPARE).
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/ilp

# The operator surface requires the token you generated in step 2.
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
