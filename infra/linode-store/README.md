# infra/linode-store — a fixture, not what the box runs

The store box (`ario`) deploys from `toon-protocol/store`'s own `deploy/` bundle, brought up by
that repo's `deploy/bootstrap.sh` from a checkout at `/root/store` (store#103). It carries its own
`connector.toml` and its own compose set — Caddy or nginx, the connector, the store app, certbot
and a label-scoped Watchtower — as committed templates in that repo, not this one.

Every file in this directory is **retained as a fixture**, not deleted, because
`crates/connector-bin/tests/devnet_configs_load.rs` `include_str!()`s them: it boots
`connector-rust.toml` through the real connector binary, checks its self-description and
settlement identity, and validates the nginx and compose files' internal shape. That coverage is
real and worth keeping — it is just no longer a claim about what the box runs.

Changing a file here changes nothing on the box. To change what the store box actually runs, open
a change in `toon-protocol/store`. `.github/workflows/fleet-ops.yml` no longer offers `box=ario` —
see [ADR 0066](../../docs/adr/0066-a-node-repository-pins-the-connector-nothing-here-moves-a-tag-onto-a-box.md).
