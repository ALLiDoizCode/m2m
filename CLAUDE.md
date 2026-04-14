# CLAUDE.md

Multi-chain ILP connector with EVM, Solana, and Mina payment channel settlement. Monorepo using npm workspaces (TypeScript) + a Rust crate (Solana program).

> **Detailed rules live in `_bmad-output/project-context.md`** -- coding standards, architecture, testing rules, chain-specific patterns, and critical implementation rules are all there. It is auto-loaded by BMAD workflows. This file covers only: quick-start setup, gotchas, tooling defaults, and MCP workflow instructions.

## Terminology

- Use **"BLS"** (not "agent runtime") for the local delivery handler component.

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

## Default UI Library: shadcn-ui v4

shadcn-ui v4 is the **only** UI component library. Do not use Material-UI, Ant Design, Chakra UI, or custom components for functionality shadcn-ui already provides.

**Workflow**: `get_component_demo` first -> `get_component` only if deep customization needed -> `list_blocks`/`get_block` for complex UIs -> verify in browser with Playwright MCP.

## Playwright MCP -- Browser Verification

Use Playwright MCP tools (`mcp__playwright__browser_*`) after UI changes. Prefer `browser_snapshot` over `take_screenshot` for interaction. Use `console_messages` and `network_requests` to debug.

## Interledger RFC Skill Activation

When the user asks about Interledger protocols or RFCs, **immediately activate** the relevant skill(s) without asking -- use `mcp__interledger_org-v4_Docs__search_rfcs_documentation`. Activate multiple skills if the question spans several RFCs.

| User question                          | Skills to activate                                   |
| -------------------------------------- | ---------------------------------------------------- |
| "How does STREAM work with ILPv4?"     | `rfc-0029-stream`, `rfc-0027-interledger-protocol-4` |
| "What's the payment pointer format?"   | `rfc-0026-payment-pointers`                          |
| "Explain the Interledger architecture" | `rfc-0001-interledger-architecture`                  |
