# CLAUDE.md

> Project-level coding standards, architecture, and testing rules are in `_bmad-output/project-context.md` (auto-loaded by BMAD workflows). This file covers tooling defaults, MCP integrations, and workflow instructions that are NOT in project-context.md.

## Terminology

- Use **"BLS"** (not "agent runtime") for the local delivery handler component.

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
