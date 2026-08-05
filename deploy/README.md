# deploy/ — recipes for running a TOON connector

There is one: **[`connector-rust/`](connector-rust/)**. Start there.

It is the Rust connector — the only connector this repository builds — with a
commented `connector.toml` you fill in, a `Dockerfile`, and a README that walks
the key material, the settlement section and the first `up -d`.

## What was here, and why it is gone

Two bundles were removed on 2026-08-05: **`pay-edge/`** ("put a TOON payment
proxy in front of your app") and **`node-quickstart/`** ("run a relay node and
join the network").

Both ran the **TypeScript connector**, pinned at
`ghcr.io/toon-protocol/connector:3.44.0`, reading a `connector.yaml`. Three
independent things had already ended that:

1. **The source is gone.** [ADR 0017](../docs/adr/0017-the-typescript-connector-is-a-prototype.md)
   made the TypeScript connector a prototype; `main` deleted its source in
   `c4a4ad10` (#465) and `2d981565` (#543), and the workflow that built the
   image is in GitHub state `deleted` — it cannot even be re-dispatched.
2. **The fleet no longer runs it.** The TOON devnet cut over to the Rust
   connector on 2026-08-04 and stopped both TypeScript containers.
3. **The image is gone.** `connector:3.44.0` was deleted from GHCR in the
   post-cutover package purge, and it was not one of the four digests archived
   beforehand. It is **unrecoverable** — so `docker compose up` in either
   bundle would have failed to pull, with nothing to explain why.

That last point is what makes deletion the honest outcome rather than a
deprecation banner: these were not stale-but-working recipes, they were
recipes whose first command could not succeed. Leaving them in place would
have cost a reader the time to discover that themselves.

## If you were using one

| you wanted                                    | go here                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a payment proxy in front of your own HTTP app | [`connector-rust/`](connector-rust/) — a `[[routes]]` entry whose `handler_url` is your app                                                                                          |
| a paid relay node                             | [`connector-rust/`](connector-rust/) for the connector, plus the [`relay` repo's own `deploy/`](https://github.com/toon-protocol/relay/tree/main/deploy) for the relay app beside it |
| a paid Arweave store node                     | the [`store` repo's `deploy/`](https://github.com/toon-protocol/store/tree/main/deploy)                                                                                              |
| two connectors peered together                | [`docs/operators/btp-peer-transport-bringup.md`](../docs/operators/btp-peer-transport-bringup.md)                                                                                    |

The relay and store bundles are the closest thing to a drop-in replacement:
both were migrated to the Rust connector in the same week (connector#755) and
both are published, self-contained images with the config baked in.

Two shapes did **not** survive the port and are worth knowing before you
reach for the git history:

- **No environment-variable layer.** `TOON_MNEMONIC`, `CONFIG_FILE` and
  `NODE_TLS_REJECT_UNAUTHORIZED` do nothing. Every value comes from one TOML
  file; identities are mounted key files.
- **No `selfAnnounce`.** The kind:10032 emitter has no counterpart in the Rust
  connector, and `deny_unknown_fields` makes writing one a config-load error
  rather than a silent no-op.

The bundles themselves remain in git history — `git log --diff-filter=D --
deploy/pay-edge deploy/node-quickstart` — if you need to read what they did.
