# The connector is a Rust library first, a binary second

The TypeScript connector's real problem is structural, not performance: `connector-node.ts`
(169 KB), `admin-api.ts` (111 KB) and `packet-handler.ts` (65 KB) are god objects, and peer
and route logic is duplicated across two surfaces that must be kept byte-identical. We are
rewriting the connector in Rust primarily because Cargo crate boundaries are enforced by the
compiler — privacy is real and dependency cycles are impossible — so the structure cannot
silently rot back into a god object the way module boundaries in one TypeScript package did.

## The shape

Five crates:

- `connector-core` — domain types and rules. No async, no network, no chain SDKs.
- `connector` — the runtime. `pub struct Connector` plus its ports. Chains are Cargo
  features (`evm`, `solana`) behind a `SettlementBackend` trait.
- `connector-api` — the [client edge](../../CONTEXT.md), exposed as
  `pub fn router(Arc<Connector>) -> axum::Router`.
- `connector-admin` — the operator surface, likewise a `Router`.
- `connectord` — the binary. Loads config, builds a `Connector`, merges routers, serves.

## Consequences

**HTTP is handed out as a `Router`, never as a server.** A Rust embedder can depend on
`connector` and call methods directly, or mount our routers into their own `axum` app. The
binary is therefore trivial, and every integration test can exercise the real router without
binding a port.

**Handlers contain no decision logic.** `connector-api` and `connector-admin` deserialize,
call exactly one method on `Connector`, and serialize. Any `if` in a handler that is not
input validation is a bug. This is the specific rule that prevents the existing
dual-control-plane duplication from being recreated: there is one brain, and HTTP is a
transport reaching it.

**TypeScript consumers move to HTTP.** `swap`, `town` and `mill` embed `ConnectorNode`
in-process today, but the coupling is one method — `ConnectorNodeLike` declares only
`sendPacket()` — and the inbound direction is already an HTTP callback to the app's handler.
The embedded node is deleted; `@toon-protocol/connector` becomes a thin HTTP client. No
native addon, no FFI, no per-platform prebuilds.
