# CLAUDE.md

> **Do not duplicate** content from `_bmad-output/project-context.md` -- that file contains all coding standards, architecture details, testing rules, and critical implementation rules. It is auto-loaded by BMAD workflows. This file covers only: quick-start setup, tooling defaults, MCP integrations, and workflow instructions.

## Terminology

- Use **"BLS"** (not "agent runtime") for the local delivery handler component.

## Quick Start

```bash
# Prerequisites: Node.js >= 22.11.0, npm >= 10.0.0
npm install

# Build all packages (root script builds shared first, then all workspaces including mina-zkapp)
npm run build

# Run all tests
make test

# Lint + format
make lint
npm run format:check
```

### Local EVM Development

```bash
make anvil-up       # Start Anvil local Ethereum node + Token Faucet (Docker)
make anvil-down     # Stop EVM services
make anvil-logs     # Follow EVM Docker Compose logs
```

### Local Solana Development

```bash
make solana-up      # Start Solana test validator + auto-deploy programs (Docker)
make solana-down    # Stop Solana services
make solana-logs    # Follow Solana Docker Compose logs
```

### All-Chain Infrastructure

```bash
make infra-up       # Start all chains (EVM + Solana)
make infra-down     # Stop all chains
```

### Solana Program (Rust)

Requires Rust toolchain + Solana CLI (`cargo build-sbf`).

```bash
make solana-build              # Build BPF program
make solana-test               # Run Rust integration tests
make solana-deploy-devnet DEPLOYER_KEYPAIR=path/to/keypair.json
```

See `docs/solana-deployment.md` for full deployment and operations guide.

### Mina zkApp (TypeScript)

Requires o1js (installed via `npm install`).

```bash
make mina-build              # Build Mina zkApp
make mina-test               # Run Mina zkApp tests
make mina-deploy-devnet DEPLOYER_KEY=<base58-private-key>
```

See `docs/mina-deployment.md` for full deployment and operations guide.

## Key Make Targets

Run `make help` for the complete list. Most-used:

| Target                    | What it does                                     |
| ------------------------- | ------------------------------------------------ |
| `make build`              | Build all packages                               |
| `make test`               | Run all tests                                    |
| `make test-unit`          | Unit tests only                                  |
| `make lint`               | ESLint                                           |
| `make clean`              | Remove `dist/` artifacts                         |
| `make anvil-up`           | Start Anvil + Faucet (`--profile evm`)           |
| `make anvil-down`         | Stop EVM services                                |
| `make solana-up`          | Start Solana test validator (`--profile solana`) |
| `make solana-down`        | Stop Solana services                             |
| `make infra-up`           | Start all chains (EVM + Solana)                  |
| `make infra-down`         | Stop all chains                                  |
| `make solana-build`       | Compile Solana program to BPF                    |
| `make solana-test`        | Run Solana Rust tests via `test-sbf`             |
| `make mina-build`         | Build Mina zkApp                                 |
| `make mina-test`          | Run Mina zkApp tests                             |
| `make mina-deploy-devnet` | Deploy Mina zkApp to devnet                      |

## Default UI Library: shadcn-ui v4

shadcn-ui v4 is the **only** UI component library for this project. Do not use Material-UI, Ant Design, Chakra UI, or custom components for functionality shadcn-ui already provides.

### Workflow

1. **Demo first** -- always call `get_component_demo` before implementing any component.
2. **Source second** -- only fetch source with `get_component` if deep customization is needed.
3. **Blocks for complex UIs** -- use `list_blocks` / `get_block` for dashboards, login pages, settings panels.
4. **Verify in browser** -- after implementing UI, use Playwright MCP tools to confirm rendering and behavior.

### Available shadcn-ui MCP Tools

| Tool                     | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `list_components`        | List all available v4 components                  |
| `get_component_demo`     | **Use first** -- demo code showing usage patterns |
| `get_component`          | Component source code                             |
| `get_component_metadata` | Dependencies, props, requirements                 |
| `list_blocks`            | Pre-built UI blocks (dashboards, forms, etc.)     |
| `get_block`              | Source code for a specific block                  |

## Playwright MCP -- Browser Verification

Use Playwright MCP tools (`mcp__playwright__browser_*`) for all browser-related tasks:

- **After UI changes**: navigate to the page and verify rendering.
- **Prefer snapshots**: use `browser_snapshot` over `take_screenshot` when you need to interact with elements.
- **Debug UI issues**: inspect `console_messages` and `network_requests`.
- **E2E / integration testing**: automate form fills, clicks, navigation flows.

Key tools: `snapshot`, `take_screenshot`, `navigate`, `click`, `type`, `fill_form`, `evaluate`, `wait_for`, `network_requests`, `console_messages`.

## Interledger RFC Skill Activation

When the user asks about Interledger protocols or RFCs:

- **Immediately activate** the relevant skill(s) without asking -- use `mcp__interledger_org-v4_Docs__search_rfcs_documentation`.
- **Activate multiple skills** if the question spans several RFCs.
- **Cross-reference** related RFCs when one references another.
- **Prefer skill-based answers** over general knowledge for RFC topics.

Examples:

| User question                          | Skills to activate                                   |
| -------------------------------------- | ---------------------------------------------------- |
| "How does STREAM work with ILPv4?"     | `rfc-0029-stream`, `rfc-0027-interledger-protocol-4` |
| "What's the payment pointer format?"   | `rfc-0026-payment-pointers`                          |
| "Explain the Interledger architecture" | `rfc-0001-interledger-architecture`                  |
