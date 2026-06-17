# CLAUDE.md

Multi-chain ILP connector with EVM, Solana, and Mina payment channel settlement. Monorepo using npm workspaces (TypeScript) + a Rust crate (Solana program).

> **Detailed rules live in `_bmad-output/project-context.md`** -- coding standards, architecture, testing rules, chain-specific patterns, and critical implementation rules are all there. It is auto-loaded by BMAD workflows. This file covers only: quick-start setup, gotchas, tooling defaults, and MCP workflow instructions.

## Terminology

- Use **"app"** (or **"handler"** when referring to the HTTP endpoint specifically) for the HTTP service the connector POSTs local delivery to — the thing the operator runs at `handler_url` in `toon.json`. Examples: "the app returns 200/4xx", "the handler endpoint", "any HTTP service is a TOON node app".
- The legacy term **"BLS"** (Business Logic Server) is **deprecated** as of 2026-05-01 (Epic 39, Story 39.15). It originated when the local delivery handler had to import the TOON SDK and do ILP-aware work; that role no longer exists post-Epic-39. Do not introduce "BLS" in new code, comments, docs, or commit messages. Existing occurrences in code/config (e.g., `packages/connector/src/core/local-delivery-client.ts` comments) are migration debt to be cleared by Story 39.15.
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
npm run test:e2e
npm run test:integration

make infra-down    # Stop all containers
```

Mock-free testing ensures the connector works correctly with actual blockchain behavior, catching real-world issues like gas estimation failures, nonce conflicts, and protocol-level edge cases.

## Default UI Library: shadcn-ui v4

shadcn-ui v4 is the **only** UI component library. Do not use Material-UI, Ant Design, Chakra UI, or custom components for functionality shadcn-ui already provides.

**Workflow**: `get_component_demo` first -> `get_component` only if deep customization needed -> `list_blocks`/`get_block` for complex UIs -> verify in browser with Playwright MCP.

## Playwright MCP -- Browser Verification

Use Playwright MCP tools (`mcp__playwright__browser_*`) after UI changes. Prefer `browser_snapshot` over `take_screenshot` for interaction. Use `console_messages` and `network_requests` to debug.

## Development Workflow Rules

### Stop-the-Line Policy (AG3)

From Epic 37 retrospective: **Nightly HTTP-surface E2E red = stop-the-line.**

**Policy:**

1. **Triage must begin within 24 hours** of a failed nightly workflow run
2. **No merges to main while nightly is red** — PR merges are blocked until the nightly suite passes
3. **Escalation path:**
   - Hour 0-4: Engineer on-call investigates, checks compose logs in Artifacts
   - Hour 4-8: If root cause not identified, escalate to team lead
   - Hour 8-24: If not resolved, emergency team sync + consider rollback

**Workflow:**

- Nightly workflow: `.github/workflows/nightly-http-surface.yml`
- Scheduled: 04:00 UTC daily
- Manual trigger: `workflow_dispatch` via Actions UI
- Failure notifications: GitHub UI (red X), job summary with escalation steps

**Reproduction commands:**

```bash
# Run the full HTTP-surface suite locally
make infra-up
npm run test:admin-surface --workspace=packages/connector
npm run test:cross-surface --workspace=packages/connector
npm run test:packet-flow --workspace=packages/connector
make infra-down
```

**Why this matters:**
The `/metrics` endpoint returned 404 in every deployed image since inception — undetected until Town's integration test caught it. This policy ensures parallel-surface drift cannot ship undetected.

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

There is **no production or staging deploy target yet.** `.github/workflows/cd.yml`
(`appleboy/ssh-action`) fails on every push to `main` with `missing server host`
because the `DEPLOY_HOST` secret is intentionally unset. **This is expected, not a
regression** — do not flag the failing CD run as quality drift or open issues for it
until a real deploy target is configured. (On-chain contract deployment for
Solana/Mina is unrelated — see "Chain-Specific Build & Deploy" above.)
