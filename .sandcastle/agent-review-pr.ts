// Single-PR review runner — the entry point the `agent:review` label→runner
// workflow (.github/workflows/agent-review.yml) invokes when `agent:review` is
// applied to ONE pull request.
//
// This is the single-pass replacement for the old 4-round `review-round:*`
// reviewer loop (pr-reviewer.yml). It runs the reviewer role (review-prompt.md
// — refactor for clarity while preserving behavior, enforce
// @.sandcastle/CODING_STANDARDS.md) against the PR's head branch, and pushes any
// refinement commits back to the PR. It NEVER merges the PR and NEVER closes
// anything — a human still merges.
//
// STANDALONE-REVIEW CAVEAT (verify on first run)
// ----------------------------------------------
// Sandcastle 0.12.0 exercises the reviewer only INSIDE the parallel loop's
// Phase 2, on a fresh `sandcastle/issue-*` branch it just created. Driving the
// same reviewer standalone against an already-existing PR head branch is our
// interpretation, not a documented engine feature. Two things to confirm on the
// first live run:
//   1. createSandbox({ branch: <existing PR head> }) checks out the EXISTING
//      branch (rather than failing because the ref already exists / creating a
//      divergent one). The workflow checks out the PR head first to help this.
//   2. The built-in {{TARGET_BRANCH}} inside review-prompt.md resolves to `main`
//      for a standalone sandbox. If the diff comes back empty, the base may be
//      resolving wrong — check the reviewer's logged `git diff` command.
//
// Required env:
//   SANDCASTLE_PR_NUMBER      the PR to review (github.event.pull_request.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write
//
// Usage:
//   SANDCASTLE_PR_NUMBER=42 npx tsx .sandcastle/agent-review-pr.ts
//   # or: npm run sandcastle:review   (with SANDCASTLE_PR_NUMBER exported)

import { execFileSync } from 'node:child_process';
import * as sandcastle from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { sandboxSecrets } from './sandbox-secrets.ts';

const prNumber = process.env.SANDCASTLE_PR_NUMBER?.trim();
if (!prNumber || !/^\d+$/.test(prNumber)) {
  throw new Error(
    'SANDCASTLE_PR_NUMBER must be set to a numeric PR number ' +
      `(got: ${JSON.stringify(process.env.SANDCASTLE_PR_NUMBER)}).`
  );
}

// Resolve the PR's head branch on the host. `gh` authenticates via GH_TOKEN.
const headRef = execFileSync(
  'gh',
  ['pr', 'view', prNumber, '--json', 'headRefName', '--jq', '.headRefName'],
  { encoding: 'utf8' }
).trim();

if (!headRef) {
  throw new Error(`Could not resolve head branch for PR #${prNumber}.`);
}

// connector is an npm-workspaces monorepo — install with the committed
// package-lock.json (`npm ci`). Mirrors main.ts / agent-implement-issue.ts.
const hooks = {
  sandbox: { onSandboxReady: [{ command: 'npm ci' }] },
};

console.log(`\n=== agent:review runner — PR #${prNumber} (head: ${headRef}) ===\n`);

const sandbox = await sandcastle.createSandbox({
  branch: headRef,
  // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN into the container (the engine's
  // env resolver does not — see ./sandbox-secrets.ts). GH_TOKEN is what the
  // review-push step's in-sandbox `git push` to the PR branch authenticates with.
  sandbox: docker({ env: sandboxSecrets() }),
  hooks,
});

try {
  const review = await sandbox.run({
    name: 'reviewer',
    maxIterations: 1,
    agent: sandcastle.claudeCode('claude-opus-4-8'),
    promptFile: './.sandcastle/review-prompt.md',
    promptArgs: { BRANCH: headRef },
  });

  if (review.commits.length > 0) {
    // Push the reviewer's refinement commits back onto the PR branch. No merge,
    // no close, no new PR — the existing PR just gets updated.
    console.log(`\nReviewer made ${review.commits.length} commit(s) — pushing to the PR branch.`);
    await sandbox.run({
      name: 'push-review',
      maxIterations: 1,
      agent: sandcastle.claudeCode('claude-opus-4-8'),
      promptFile: './.sandcastle/review-push-prompt.md',
      promptArgs: { BRANCH: headRef },
    });
  } else {
    console.log('\nReviewer made no changes — the code was already clean. Nothing to push.');
  }
} finally {
  await sandbox.close();
}

console.log('\nReview complete. The PR was NOT merged — a human still merges.');
