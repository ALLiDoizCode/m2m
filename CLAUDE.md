# CLAUDE.md

Multi-chain ILP connector with EVM, Solana, and Mina payment channel settlement. Monorepo using npm workspaces (TypeScript) + a Rust crate (Solana program).

> **Detailed rules live in `_bmad-output/project-context.md`** -- coding standards, architecture, testing rules, chain-specific patterns, and critical implementation rules are all there. It is auto-loaded by BMAD workflows. This file covers only: quick-start setup, gotchas, tooling defaults, and MCP workflow instructions.

## Terminology

- Use **"app"** (or **"handler"** when referring to the HTTP endpoint specifically) for the HTTP service the connector POSTs local delivery to — the thing the operator runs at `handler_url` in `toon.json`. Examples: "the app returns 200/4xx", "the handler endpoint", "any HTTP service is a TOON node app".
- The legacy term **"BLS"** (Business Logic Server) is **deprecated** as of 2026-05-01 (Epic 39, Story 39.15). It originated when the local delivery handler had to import the TOON SDK and do ILP-aware work; that role no longer exists post-Epic-39. Do not introduce "BLS" in new code, comments, docs, or commit messages. The migration is complete in code: `packages/` has zero remaining "BLS" occurrences. Other repo locations — `CHANGELOG.md`, `docs/`, `scripts/`, `_bmad-output/` — may still reference the legacy term as historical record.
- The term **"terminator"** (and "connector-as-terminator", "app-behind-terminator") is **deprecated**. There is no separate "terminator" role: it is just the **connector** acting as a paid reverse proxy in front of an **app**. The two roles are **`app`** and **`connector`**. Use "connector" (or "the connector acting as a paid reverse proxy") instead. Do not introduce "terminator" in new code, comments, docs, config, compose services/profiles, route addresses, or commit messages. NOTE: this does **not** affect the route-**termination** feature schema — the TypeScript types `RouteTermination`/`RouteTerminationRegistry`/`RouteTerminationSink`, functions `resolveTermination`/`toRouteTermination`, the `termination` config fields, and `checkRequestBinding` are the "route termination" feature and are unchanged.
- **Never** use "agent runtime" — that term is deprecated from before "BLS" and is not coming back.

## Quick Start

```bash
# Prerequisites: Node.js >= 22.11.0, npm >= 10.0.0
npm install
npm run build    # Builds shared first, then all workspaces (including mina-zkapp)
make test        # Run all tests
make lint        # ESLint
npm run format:check
```

### Local Infrastructure

```bash
make anvil-up / anvil-down / anvil-logs    # EVM (Anvil + Token Faucet)
make solana-up / solana-down / solana-logs  # Solana test validator
make mina-up / mina-down / mina-logs       # Mina lightnet
make infra-up / infra-down                 # All chains at once
```

### Chain-Specific Build & Deploy

```bash
# Solana (requires Rust toolchain + Solana CLI)
make solana-build   # BPF program
make solana-test    # Rust integration tests
make solana-deploy-devnet DEPLOYER_KEYPAIR=path/to/keypair.json

# Mina (requires o1js, installed via npm install)
make mina-build     # zkApp
make mina-test      # zkApp tests
make mina-deploy-devnet DEPLOYER_KEY=<base58-private-key>
```

Run `make help` for the full target list. Deployment guides: `docs/solana-deployment.md`, `docs/mina-deployment.md`.

## Testing Guidelines

**Never use mocks.** All tests must use real implementations.

**E2E and Integration Tests:** Always run against local Docker containers (Anvil, Solana test validator, Mina lightnet). Use the local infrastructure commands:

```bash
make infra-up      # Start all chain containers
make anvil-up      # Start EVM container only
make solana-up     # Start Solana container only
make mina-up       # Start Mina container only

# Run tests against live containers
cargo test --workspace --exclude payment-channel

make infra-down    # Stop all containers
```

Mock-free testing ensures the connector works correctly with actual blockchain behavior, catching real-world issues like gas estimation failures, nonce conflicts, and protocol-level edge cases.

## Default UI Library: shadcn-ui v4

shadcn-ui v4 is the **only** UI component library. Do not use Material-UI, Ant Design, Chakra UI, or custom components for functionality shadcn-ui already provides.

**Workflow**: `get_component_demo` first -> `get_component` only if deep customization needed -> `list_blocks`/`get_block` for complex UIs -> verify in browser with Playwright MCP.

## Playwright MCP -- Browser Verification

Use Playwright MCP tools (`mcp__playwright__browser_*`) after UI changes. Prefer `browser_snapshot` over `take_screenshot` for interaction. Use `console_messages` and `network_requests` to debug.

## Development Workflow Rules

### Stop-the-Line Policy (AG3) — RETIRED with the embedded node (#457)

Epic 37's stop-the-line policy hung off the nightly HTTP-surface suite
(`.github/workflows/nightly-http-surface.yml`, plus the `test:admin-surface`,
`test:cross-surface` and `test:packet-flow` scripts). All of it exercised the
TypeScript connector's in-process admin/BTP/packet-flow surfaces, which #457
deleted along with `ConnectorNode`; the workflow and the scripts are gone.

The policy's point still stands — parallel-surface drift must not ship
undetected (`/metrics` returned 404 in every deployed image since inception,
caught only by Town's integration test). Re-establishing an equivalent nightly
against the **Rust** connector belongs with #431's cutover.

---

## Interledger RFC Skill Activation

When the user asks about Interledger protocols or RFCs, **immediately activate** the relevant skill(s) without asking -- use `mcp__interledger_org-v4_Docs__search_rfcs_documentation`. Activate multiple skills if the question spans several RFCs.

| User question                          | Skills to activate                                   |
| -------------------------------------- | ---------------------------------------------------- |
| "How does STREAM work with ILPv4?"     | `rfc-0029-stream`, `rfc-0027-interledger-protocol-4` |
| "What's the payment pointer format?"   | `rfc-0026-payment-pointers`                          |
| "Explain the Interledger architecture" | `rfc-0001-interledger-architecture`                  |

---

## Deployment status

There is **no production or staging deploy target yet.** The deploy path is
`.github/workflows/devnet-deploy.yml` plus the `deploy/` bundle, driven by the
`LINODE_CLI_TOKEN` secret (the Linode / baked-image model). A prior generic
SSH-based CD workflow was removed (issue #407) because it assumed secrets
that never existed at repo or org scope and failed on every push to `main`.
If staging is wanted later, author it fresh against the Linode/baked-image
model above, not a resurrected SSH workflow. (On-chain contract deployment
for Solana/Mina is unrelated — see "Chain-Specific Build & Deploy" above.)
