# Source Code Structure

The connector is a Cargo workspace. The npm-workspace layout this page used to describe
(`packages/connector`, `packages/shared`, `tools/send-packet`) was deleted with the TypeScript
prototype — [ADR 0017](../adr/0017-the-typescript-connector-is-a-prototype.md).

## Top level

```
connector/
  crates/          # the connector — see below
  packages/        # not the connector: contracts, and devnet faucet tooling
  vectors/         # wire-vectors.json, the cross-repo contract (ADR 0021)
  docs/            # ADRs, protocol specs, operator docs
  deploy/          # container image and deployment recipes
  infra/           # devnet overlays (Linode boxes, local chain compose files)
  tools/           # fund-peers, and chain-specific scripts
  Cargo.toml       # the workspace manifest
```

## `crates/` — the connector

Layered, and the layering is enforced by which crate may depend on which
([ADR 0001](../adr/0001-rust-workspace-library-first.md)). Nothing below depends on anything
above it.

```
connector-domain                 pure logic: no async, no I/O, no clock, no keys
  ├─ packet.rs, oer.rs           ILPv4 packets and their canonical OER encoding (ADR 0023)
  ├─ address.rs, route.rs        ILP addresses; longest-prefix selection
  ├─ fee.rs                      flat per-packet fee and minimum-delivery arithmetic (ADR 0010)
  ├─ condition.rs                condition/fulfilment/expiry rules
  ├─ claim.rs, client_claim.rs   nonce, watermark and value rules
  └─ envelope.rs                 the request/response envelope a terminated packet carries

connector-signer                 the only crate that touches key material (ADR 0012)
  ├─ signer.rs, local.rs, kms.rs the Signer port and its backends
  ├─ giftwrap.rs                 seal/open, and the derived fulfilment (ADRs 0018, 0019)
  ├─ claim_signature.rs          EIP-712 and Ed25519 balance-proof verification (ADR 0024)
  └─ treasury.rs, address.rs

connector-config                 one typed TOML file and every refuse-to-start error (ADR 0009)

connector-settlement             the chain-agnostic settlement port + its contract suite
  ├─ port.rs, contract.rs        the port, and the one suite every backend is run against
  └─ in_memory.rs                the fake
connector-settlement-evm         real EVM backend: TokenNetworkRegistry → TokenNetwork
connector-settlement-solana      real Solana backend — drives packages/solana-program (the deployed payment-channel program)

connector-runtime                the packet plane and its ports
  ├─ connector.rs                Connector — routing, delivery, fees, rejects
  ├─ peer_transport.rs           the peer transport port (ADR 0027's seam); the raw-TCP wire behind it was deleted in #679
  ├─ app_client.rs               the port to the app behind a terminated route
  ├─ claim.rs, journal.rs        ClaimBook, exposure and the projection (ADR 0005)
  ├─ route.rs                    leased routes; the swapped snapshot (ADR 0015)
  └─ metrics.rs, operator_view.rs

connector-client-edge            axum Router: POST /ilp, /ilp/identity, /ilp/routes/price
connector-operator               axum Router: bearer-gated reads, RFC 9421-signed writes
connector-cli                    config → runtime → merged routers → bound listeners
connector-bin                    bin/connector, bin/stub-app
connector-vectors                bin/generate-vectors → vectors/wire-vectors.json
```

## `packages/` — not the connector

| Directory              | What it is                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts`            | Solidity (Foundry). `TokenNetwork`, `TokenNetworkRegistry`, `RollingSwapChannel`. The repository's only git submodules (OpenZeppelin, forge-std) live here. |
| `solana-program`       | The legacy SPL-token payment-channel program. A workspace member, excluded from the main gate.                                                              |
| `faucet`               | Devnet faucet service (plain JavaScript).                                                                                                                   |
| `mina-zkapp`           | Mina zkApp (TypeScript, o1js).                                                                                                                              |
| `mina-usdc-faucet-web` | Faucet browser dApp (TypeScript, Vite).                                                                                                                     |

## Test layout

There is no separate test tree for unit tests. Following Rust convention:

- **Unit tests** live in a `#[cfg(test)] mod tests` at the bottom of the module they test.
  `proptest` properties live beside them.
- **Integration tests** are their own binaries under `crates/<crate>/tests/`. Several drive a real
  chain (`anvil`, `solana-test-validator`) and are skipped when it is absent locally, but
  **panic** when `CI` is set, so the gate cannot go green without one.
- **Contract suites** — the one place a port's behaviour is defined — live with the port and are
  run against every implementation, fake and real
  ([ADR 0007](../adr/0007-testing-doctrine-fakes-yes-mocks-no.md)).
- **Vectors** are generated, not written: `crates/connector-vectors` emits
  `vectors/wire-vectors.json`, and `crates/connector-vectors/tests/vectors_up_to_date.rs` fails
  the gate if the committed file is stale.
