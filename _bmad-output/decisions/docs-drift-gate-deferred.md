# Deferred: Config-schema / Docs Drift CI Gate

**Status:** Deferred to a future story
**Date:** 2026-04-15
**Context:** Epic 35 retrospective action item #4 (Medium).

## Problem

Transport config (and, looking forward, other config blocks) is validated in
`packages/connector/src/config/config-loader.ts` with hand-written runtime
validators. The corresponding operator-facing documentation lives in
`docs/ator-transport.md` and similar markdown files. There is no automated
check that field names, allowed values, error messages, or required/optional
status stay in sync between the two.

The retro flagged this as "near-inevitable" drift without automation.

## Why this is deferred

A lightweight solution does not exist today:

- The config layer does **not** use Zod or any other schema library with
  introspectable metadata. All validation is imperative TypeScript. There is
  no schema object to diff against docs.
- A "grep every field name out of the validator and check each appears in
  the docs" script would be noisy (matches appear in test fixtures,
  examples, and error strings) and would produce false positives that
  erode trust.
- The right long-term shape is a proper schema library (Zod or JSON Schema)
  with docs generated or cross-checked from it. That is a medium-to-large
  refactor that crosses many config blocks, not just transport.

Doing a bolted-on keyword-linter before that refactor lands would add
maintenance cost without solving the underlying problem.

## Proposed follow-up story

"Migrate config validation to Zod and generate operator docs fragments from
the schema." Scope:

- Introduce Zod schemas for `TransportConfig` first (smallest surface).
- Emit a doc fragment from the Zod schema (field / type / required /
  description) at build time.
- Add a CI gate that fails if the committed fragment in `docs/` differs
  from the generated one.
- Iterate the pattern to cover `PeerConfig`, `RouteConfig`, settlement
  blocks in subsequent stories.

Dependency note: action item #9 in the Epic 35 retro ("Complete Zod schema
migration") is a sibling concern. These two should be tackled together in
the same follow-up epic so migration and docs-drift gating are one design
rather than two.

## Interim mitigation

Team agreement #7 from the Epic 35 retro — "config schema changes require
corresponding docs changes in the same story" — remains in force as a
review-time rule until the automated gate lands.
