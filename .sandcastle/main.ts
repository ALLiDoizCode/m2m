// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// NOTE: main.ts is the full AUTONOMOUS engine (planner → parallel implement +
// review → MERGE + close). It is NOT what the `agent:implement` label runner
// invokes — that is the single-issue PR-mode runner in
// ./agent-implement-issue.ts. main.ts is reserved for later backlog-draining.
//
// Usage:
//   npx tsx .sandcastle/main.ts
// Or via package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.ts" }
//
// CJS NOTE: connector's root package.json has no `"type": "module"` (it is a
// CJS npm-workspaces repo), so tsx/esbuild transforms this runner to CommonJS,
// where top-level `await` is a compile error. The async loop therefore lives in
// `main()` and is invoked below WITHOUT top-level await. Do NOT reintroduce
// top-level await here. (Every other org repo is `type: module`; connector is
// the sole exception, which is why only its runner hit this.)

import * as sandcastle from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { z } from 'zod';
import { sandboxSecrets } from './sandbox-secrets.ts';

// Forward host secrets into every sandbox this loop spawns. The engine's env
// resolver only passes vars that appear in the gitignored `.sandcastle/.env`,
// so in CI CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN would otherwise never reach the
// container. See ./sandbox-secrets.ts for the full root-cause note.
const sandboxEnv = sandboxSecrets();

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(z.object({ id: z.string(), title: z.string(), branch: z.string() })),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// connector is an npm-WORKSPACES monorepo (NOT pnpm): install with the committed
// package-lock.json so the sandbox resolves the exact dependency tree. `npm ci`
// is npm's frozen-lockfile equivalent (it errors if package.json and the lock
// disagree, and wipes node_modules first). This replaces the template's default
// `npm install`.
//
// Two connector-specific caveats a live run must handle in its gate (documented
// in implement-prompt.md), not here:
//   - The mina-zkapp (o1js) jest suite is WASM-heavy — it needs
//     NODE_OPTIONS=--max-old-space-size and --runInBand or it OOMs.
//   - CI installs @libsql/linux-x64-gnu explicitly because package-lock.json was
//     generated on macOS; on a Linux sandbox `npm ci` should pull the linux
//     optional dep automatically, but if a libsql-backed test can't find its
//     native module, re-run `npm install @libsql/linux-x64-gnu --no-save`.
const hooks = {
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth deterministically inside the container. The engine
      // (@ai-hero/sandcastle@0.12.0) configures git identity + safe.directory
      // but NO credential helper, so a bare `git push` is unauthenticated and
      // only succeeds by luck. `gh auth setup-git` installs `gh` as git's
      // credential helper (reads GH_TOKEN at push time, stores no token in any
      // file). Guarded on GH_TOKEN so token-less local dev no-ops rather than
      // aborting setup. See ./agent-implement-issue.ts for the full note.
      { command: 'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; fi' },
      // Install command UNCHANGED (npm-workspaces `npm ci`, not pnpm).
      { command: 'npm ci' },
    ],
  },
};

// NOTE: the stock template copies the host `node_modules` into the worktree
// (`copyToWorktree: ["node_modules"]`) for fast startup. We DROP it: connector
// pulls platform-specific native modules (o1js WASM, libsql, bigint-buffer),
// and copying a host-resolved tree across the host→worktree bind-mount risks
// serving the wrong-platform binaries. The `npm ci` hook above populates deps
// inside the sandbox instead.

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

    // -------------------------------------------------------------------------
    // Phase 1: Plan
    //
    // The planning agent (opus, for deeper reasoning) reads the open issue list,
    // builds a dependency graph, and selects the issues that can be worked in
    // parallel right now (i.e., no blocking dependencies on other open issues).
    //
    // It outputs a <plan> JSON block — Output.object parses and validates it.
    // -------------------------------------------------------------------------
    const plan = await sandcastle.run({
      hooks,
      sandbox: docker({ env: sandboxEnv }),
      name: 'planner',
      // One iteration is enough: the planner just needs to read and reason,
      // not write code. (Structured output requires maxIterations: 1.)
      maxIterations: 1,
      // Opus for planning: dependency analysis benefits from deeper reasoning.
      agent: sandcastle.claudeCode('claude-opus-5'),
      promptFile: './.sandcastle/plan-prompt.md',
      // Extract and validate the <plan> JSON into a typed object. Throws
      // StructuredOutputError if the tag is missing, the JSON is malformed, or
      // validation fails — which aborts the loop.
      output: sandcastle.Output.object({ tag: 'plan', schema: planSchema }),
    });

    const issues = plan.output.issues;

    if (issues.length === 0) {
      // No unblocked work — either everything is done or everything is blocked.
      console.log('No unblocked issues to work on. Exiting.');
      break;
    }

    console.log(`Planning complete. ${issues.length} issue(s) to work in parallel:`);
    for (const issue of issues) {
      console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
    }

    // -------------------------------------------------------------------------
    // Phase 2: Execute + Review
    //
    // For each issue, create a sandbox via createSandbox() so the implementer
    // and reviewer share the same sandbox instance per branch. The implementer
    // runs first; if it produces commits, the reviewer runs in the same sandbox.
    //
    // Promise.allSettled means one failing pipeline doesn't cancel the others.
    // -------------------------------------------------------------------------

    const settled = await Promise.allSettled(
      issues.map(async (issue) => {
        const sandbox = await sandcastle.createSandbox({
          branch: issue.branch,
          sandbox: docker({ env: sandboxEnv }),
          hooks,
        });

        try {
          // Run the implementer
          const implement = await sandbox.run({
            name: 'implementer',
            maxIterations: 100,
            agent: sandcastle.claudeCode('claude-sonnet-5'),
            promptFile: './.sandcastle/implement-prompt.md',
            promptArgs: {
              TASK_ID: issue.id,
              ISSUE_TITLE: issue.title,
              BRANCH: issue.branch,
            },
          });

          // Only review if the implementer produced commits
          if (implement.commits.length > 0) {
            // review-prompt.md now requires ISSUE_NUMBER/ISSUE_TITLE (the Spec
            // axis, toon-meta#275) — an unresolved {{...}} placeholder fails the
            // run, so pass them here too. This reserved autonomous loop does not
            // yet CONSUME the reviewer's <review> verdict; the label runners
            // (agent-implement-issue.ts / agent-review-pr.ts) enforce it via
            // ./review-verdict.ts, and wiring it into this merge phase is part
            // of the auto-merge work (toon-meta#270).
            const review = await sandbox.run({
              name: 'reviewer',
              maxIterations: 1,
              agent: sandcastle.claudeCode('claude-opus-5'),
              promptFile: './.sandcastle/review-prompt.md',
              promptArgs: {
                BRANCH: issue.branch,
                ISSUE_NUMBER: issue.id,
                ISSUE_TITLE: issue.title,
              },
            });

            // Merge commits from both runs so the merge phase sees all of them.
            // Each sandbox.run() only returns commits from its own run.
            return {
              ...review,
              commits: [...implement.commits, ...review.commits],
            };
          }

          return implement;
        } finally {
          await sandbox.close();
        }
      })
    );

    // Log any agents that threw (network error, sandbox crash, etc.).
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        console.error(`  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`);
      }
    }

    // Only pass branches that actually produced commits to the merge phase.
    // An agent that ran successfully but made no commits has nothing to merge.
    const completedIssues = settled
      .map((outcome, i) => ({ outcome, issue: issues[i]! }))
      .filter(
        (entry) => entry.outcome.status === 'fulfilled' && entry.outcome.value.commits.length > 0
      )
      .map((entry) => entry.issue);

    const completedBranches = completedIssues.map((i) => i.branch);

    console.log(`\nExecution complete. ${completedBranches.length} branch(es) with commits:`);
    for (const branch of completedBranches) {
      console.log(`  ${branch}`);
    }

    if (completedBranches.length === 0) {
      // All agents ran but none made commits — nothing to merge this cycle.
      console.log('No commits produced. Nothing to merge.');
      continue;
    }

    // -------------------------------------------------------------------------
    // Phase 3: Merge
    //
    // One agent merges all completed branches into the current branch,
    // resolving any conflicts and running tests to confirm everything works.
    //
    // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
    // uses to know which branches to merge and which issues to close.
    // -------------------------------------------------------------------------
    await sandcastle.run({
      hooks,
      sandbox: docker({ env: sandboxEnv }),
      name: 'merger',
      maxIterations: 1,
      agent: sandcastle.claudeCode('claude-opus-5'),
      promptFile: './.sandcastle/merge-prompt.md',
      promptArgs: {
        // A markdown list of branch names, one per line.
        BRANCHES: completedBranches.map((b) => `- ${b}`).join('\n'),
        // A markdown list of issue IDs and titles, one per line.
        ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join('\n'),
      },
    });

    console.log('\nBranches merged.');
  }

  console.log('\nAll done.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
