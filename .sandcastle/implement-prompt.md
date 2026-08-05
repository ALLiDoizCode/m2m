# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue. **Use the `--json` form** — a bare `gh issue view <ID>` FAILS on
this repository:

```
gh issue view <ID> --json title,body,labels --jq '"# " + .title + "\n\n" + .body'
```

A classic Project is attached, so any porcelain `gh issue view` / `gh pr view`
call dies with `GraphQL: Projects (classic) is being deprecated ...
(repository.issue.projectCards)` and prints nothing else. The `--json` form takes
a different code path and works. Issue comments are on the REST API, not that
command:

```
gh api repos/toon-protocol/connector/issues/<ID>/comments --jq '.[].body'
```

Read the comments as well as the body — corrections, blockers and decisions
frequently live there rather than in the original description.

If the issue has a parent PRD, pull that in the same way. Do not proceed on the
title alone; if you cannot read the body, say so and stop rather than guessing at
the acceptance criteria.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

The gate below is ENFORCED. After you finish, the runner executes it itself and
will not open a PR if it is red — you get a bounded number of fix iterations with
the exact failure output, and then the run fails. So running it yourself as you
go is not a formality; it is the difference between finishing and being handed
your own compile error.

## Rust — `crates/`, the #409 rewrite

If you touched anything under `crates/`, `Cargo.toml` or `Cargo.lock`, run these
from the repo root. They are exactly what CI's `Rust Workspace Gate` runs:

- format: `cargo fmt --all -- --check`
- build: `cargo build --workspace`
- test: `cargo test --workspace --exclude payment-channel`
- lint: `cargo clippy --workspace --exclude payment-channel --all-targets -- -D warnings`

`anvil` and `cast` (Foundry v1.7.1) are installed in this container, so the EVM
settlement tests bring up a real local chain and genuinely run. Per ADR 0007 that
is the design: each integration test spawns its own disposable chain. A chain
test that reports `finished in 0.00s` did NOT run — treat that as a failure and
find out why, do not report it as passing.

Two clippy notes that have bitten before: `-D warnings` with `--all-targets`
makes dead code a hard error, so a shared `tests/support/mod.rs` used by several
test binaries needs `#![allow(dead_code)]`; and `cargo fmt` is the FIRST step, so
a formatting slip fails the gate before your tests ever run.

## TypeScript — `packages/`

connector is an npm-workspaces monorepo with a hand-ordered build
(`shared` → `mina-zkapp` → the rest). If you touched anything under `packages/`,
run connector's real gate from the repo root and make sure every command passes:

- lint: `npm run lint --workspaces --if-present`
- typecheck: `npm run typecheck` (builds `shared` + `mina-zkapp` first so the
  project references resolve, then runs `tsc --noEmit` in each workspace)
- build (ordered): `npm run build` (this is exactly
  `shared` → `mina-zkapp` → `--workspaces --if-present`; do not reorder it)
- test: `npm run test --workspaces --if-present`

Two connector-specific gotchas when running the test gate:

- The `mina-zkapp` (o1js) jest suite is WASM-heavy. Run it with more heap and in
  band or it OOMs:
  `NODE_OPTIONS='--max-old-space-size=8192' npm test --workspace=packages/mina-zkapp -- --runInBand`
- The npm workspaces that remain are devnet tooling only (the faucet, its Mina
  zkApp, the faucet dApp, `tools/fund-peers`). The connector itself is Rust —
  the Rust gate is the one that matters for connector changes.

Do not commit until the gates that apply to what you changed all pass.

If a gate fails and you cannot fix it, say so plainly and explain what is
blocking you. Do not weaken, skip, delete or `#[ignore]` a test to get green, and
do not loosen a lint threshold — a gate that was made to pass proves nothing, and
the whole reason it is enforced from outside is that self-reported success is not
evidence.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.

## Context budget

Operate as if your context is capped at **~200k tokens**, whatever your model's actual window
is (org policy: toon-meta's `CLAUDE.md` → _Context budget policy_ — the cap is absolute, not a
percentage of the window, because a percentage means different things on different models).
Treat ~200k as a hard ceiling, not a target, and do the real work well below it.

Start preparing a handoff at roughly **120k** tokens of context, and hand off no later than
roughly **160k** — never run to the ceiling. Handing off means: write a structured handoff note
(goal and remaining work as a concrete task list; what has been done and where — files,
branches, commits; key decisions and why; exact paths/line numbers instead of "see above") to
`.sandcastle/logs/handoff-<task-id>.md`, **commit it on this branch** (use `git add -f` —
`.sandcastle/.gitignore` ignores `logs/`, and the sandbox is destroyed when the run ends, so an
uncommitted note is lost), and end your turn so a fresh agent continues. Small, resumable units
beat one degraded run.
