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
//
// CJS NOTE: connector's root package.json has no `"type": "module"` (it is a
// CJS npm-workspaces repo), so tsx/esbuild transforms this runner to CommonJS,
// where top-level `await` is a compile error. The async body therefore lives in
// `main()` and is invoked below WITHOUT top-level await. Do NOT reintroduce
// top-level await here. (Every other org repo is `type: module`; connector is
// the sole exception, which is why only its runner hit this.)

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
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth deterministically inside the container. This
      // reviewer runner PUSHES the reviewer's refinement commits to the PR head
      // branch (review-push-prompt.md); @ai-hero/sandcastle@0.12.0 wires no git
      // credential helper, so that push would otherwise be unauthenticated and
      // only succeed by luck. `gh auth setup-git` installs `gh` as git's helper
      // (reads GH_TOKEN at push time, stores no token in any file). Guarded on
      // GH_TOKEN so token-less local dev no-ops. See ./agent-implement-issue.ts.
      { command: 'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; fi' },
      // Install command UNCHANGED (npm-workspaces `npm ci`, not pnpm).
      { command: 'npm ci' },
    ],
  },
};

console.log(`\n=== agent:review runner — PR #${prNumber} (head: ${headRef}) ===\n`);

async function main() {
  // Set to a non-null message below if the push-review phase reported success but
  // the reviewer's commits never landed on origin. Recorded here so the `finally`
  // still closes the sandbox before we fail the job non-zero.
  let reviewPushVerificationError: string | null = null;

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
      agent: sandcastle.claudeCode('claude-sonnet-5'),
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
        agent: sandcastle.claudeCode('claude-sonnet-5'),
        promptFile: './.sandcastle/review-push-prompt.md',
        promptArgs: { BRANCH: headRef },
      });

      // FAIL LOUD (analogous to agent-implement-issue.ts). The push-review phase
      // reports COMPLETE from its prompt whether or not the in-sandbox `git push`
      // actually landed. Verify from the HOST (authenticated via GH_TOKEN) that
      // every reviewer commit now exists on origin. A commit that is only local
      // 404s here, proving the push failed silently — record the error so the job
      // goes red instead of green-lying (store#50 class of bug).
      const nwo = execFileSync(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
        { encoding: 'utf8' }
      ).trim();

      const missing = review.commits.filter((c) => {
        try {
          execFileSync('gh', ['api', `repos/${nwo}/commits/${c.sha}`], { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      });

      if (missing.length === 0) {
        console.log(
          `\nVerified: all ${review.commits.length} reviewer commit(s) are on origin (${headRef}).`
        );
      } else {
        reviewPushVerificationError =
          `\nERROR: the push-review phase reported COMPLETE, but ${missing.length} ` +
          `reviewer commit(s) are absent from origin for branch '${headRef}': ` +
          `${missing.map((c) => c.sha.slice(0, 8)).join(', ')}.\n` +
          `  The in-sandbox \`git push\` to the PR branch failed silently. ` +
          `Inspect the push-review phase logs above. The Actions job is failing ` +
          `deliberately so this is not mistaken for success.`;
      }
    } else {
      console.log('\nReviewer made no changes — the code was already clean. Nothing to push.');
    }
  } finally {
    await sandbox.close();
  }

  // Fail loud AFTER the sandbox is closed: a silently-failed push must turn the
  // Actions job red, never green.
  if (reviewPushVerificationError) {
    console.error(reviewPushVerificationError);
    process.exit(1);
  }

  console.log('\nReview complete. The PR was NOT merged — a human still merges.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
