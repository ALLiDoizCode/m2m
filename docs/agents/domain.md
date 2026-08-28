# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the connector's glossary. Terms only; decisions live in ADRs.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

There is no `CONTEXT-MAP.md` and there are no per-package `CONTEXT.md` files. The npm workspaces
under `packages/*` and the Cargo members under `crates/*` are build units, not separate bounded
contexts — one connector domain spans them.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-rust-workspace-library-first.md
│   ├── 0002-drop-mina-from-the-rust-connector.md
│   └── …
├── packages/     ← npm workspaces
└── crates/       ← Cargo workspace
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary
explicitly avoids.

`CONTEXT.md` marks retired vocabulary with an `_Avoid_:` line, and `CLAUDE.md` carries the same
bans in its Terminology section. Both are binding: **app**/**handler** not "BLS" or "agent
runtime"; **connector** not "terminator". The one exception is the route-**termination** feature
schema (`RouteTermination`, `resolveTermination`, the `termination` config fields), which keeps its
name.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing
language the project doesn't use (reconsider) or there's a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0016 (payload opacity is a property of carriage) — but worth reopening because…_
