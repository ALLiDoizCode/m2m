# infra/linode-relay — a fixture, not what the box runs

The relay box deploys from `toon-protocol/relay`'s own `deploy/` bundle, brought up by that repo's
`deploy/bootstrap.sh` from a checkout at `/root/relay` (relay#144). It runs Caddy (not nginx) in
front of a `relay-connector` image that repo publishes with its own `connector.toml` baked in, not
a checkout of this repo's `connector-rust.toml`.

Every file in this directory is **retained as a fixture**, not deleted, because
`crates/connector-bin/tests/devnet_configs_load.rs` `include_str!()`s them: it boots
`connector-rust.toml` through the real connector binary, checks its self-description and
settlement identity, and validates the nginx and compose files' internal shape. That coverage is
real and worth keeping — it is just no longer a claim about what the box runs.

The rolling-swap maker sidecar (`docker-compose.relay.swap.yml`, `swap.config.json`) was
co-located here because the relay box was what it announced through (toon-meta#402); its home
going forward is tracked separately (relay#144) and is unaffected by this note.

Changing a file here changes nothing on the box. To change what the relay box actually runs, open
a change in `toon-protocol/relay`. `.github/workflows/fleet-ops.yml` no longer offers `box=relay` —
see [ADR 0068](../../docs/adr/0068-a-node-repository-pins-the-connector-nothing-here-moves-a-tag-onto-a-box.md).
