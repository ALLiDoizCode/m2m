// Dry-run "plan" — Phase 1 of parallel-planner-with-review in isolation.
//
// Sandcastle 0.12.0 ships NO `sandcastle plan` / `--dry-run` CLI command
// (the CLI is only `init` + `docker|podman build-image|remove-image`). The
// factory's "dry-run plan" is therefore this: run ONLY the planner phase —
// a read-only, maxIterations:1 opus pass that reads the open `agent:implement`
// issue list, builds a dependency graph, and emits a validated <plan> — then
// print it and EXIT WITHOUT implementing, reviewing, or merging anything.
//
// Requirements (same as a real run):
//   - Docker daemon on the host (the planner runs in the sandcastle image).
//   - The image built:            npx @ai-hero/sandcastle docker build-image
//   - A Claude credential in      .sandcastle/.env  (CLAUDE_CODE_OAUTH_TOKEN)
//     — org Actions secret in CI. GH_TOKEN so the in-sandbox `gh issue list`
//     can read issues.
//
// Usage:
//   npx tsx .sandcastle/plan-dry-run.ts
//   # or: npm run sandcastle:plan
//
// An empty backlog validly prints <plan>{"issues": []}</plan> — that still
// proves the mechanism end-to-end (auth + sandbox + gh + schema validation).
//
// CJS NOTE: connector's root package.json has no `"type": "module"` (it is a
// CJS npm-workspaces repo), so tsx/esbuild transforms this runner to CommonJS,
// where top-level `await` is a compile error. The async body therefore lives in
// `main()` and is invoked below WITHOUT top-level await. Do NOT reintroduce
// top-level await here. (Every other org repo is `type: module`; connector is
// the sole exception, which is why only its runner hit this.)

import * as sandcastle from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { z } from 'zod';
import { sandboxSecrets } from './sandbox-secrets.ts';

// Same schema the real loop validates the planner's <plan> against (main.ts).
const planSchema = z.object({
  issues: z.array(z.object({ id: z.string(), title: z.string(), branch: z.string() })),
});

// connector is an npm-workspaces monorepo — install with the committed
// package-lock.json (`npm ci`, mirrors main.ts). We do NOT copyToWorktree
// node_modules (platform-specific native modules must resolve in the sandbox).
const hooks = {
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth deterministically inside the container. This
      // dry-run planner never pushes, but the guard is kept identical across
      // every runner entrypoint so the factory has one credential-setup story
      // (idempotent; no-ops without GH_TOKEN). See ./agent-implement-issue.ts.
      { command: 'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; fi' },
      // Install command UNCHANGED (npm-workspaces `npm ci`, not pnpm).
      { command: 'npm ci' },
    ],
  },
};

async function main() {
  const plan = await sandcastle.run({
    hooks,
    // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN into the container; the engine's
    // env resolver does not (see ./sandbox-secrets.ts). The planner needs the
    // Claude credential and GH_TOKEN for the in-sandbox `gh issue list`.
    sandbox: docker({ env: sandboxSecrets() }),
    name: 'planner-dry-run',
    maxIterations: 1,
    agent: sandcastle.claudeCode('claude-opus-5'),
    promptFile: './.sandcastle/plan-prompt.md',
    output: sandcastle.Output.object({ tag: 'plan', schema: planSchema }),
  });

  const { issues } = plan.output;

  console.log(`\n=== DRY-RUN PLAN (${issues.length} unblocked issue(s)) ===\n`);
  if (issues.length === 0) {
    console.log('No unblocked agent:implement issues. Empty plan is still a valid pass.');
  } else {
    for (const issue of issues) {
      console.log(`  ${issue.id}: ${issue.title} -> ${issue.branch}`);
    }
  }
  console.log('\nDry run complete — nothing was implemented, reviewed, or merged.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
