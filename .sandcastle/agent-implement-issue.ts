// Single-issue PR-mode implement runner — the entry point the
// `agent:implement` label→runner workflow (.github/workflows/agent-implement.yml)
// invokes for ONE explicitly-labeled issue.
//
// How this differs from the full autonomous loop in `main.ts`:
//   - main.ts  = the multi-issue autonomous engine: Phase 1 planner scans ALL
//                open `agent:implement` issues, Phase 2 implements+reviews them
//                in parallel, Phase 3 MERGES every branch into the checked-out
//                branch and CLOSES the issues. That is the "auto-merge" engine,
//                reserved for later (backlog draining).
//   - this file = human-in-the-loop, ONE issue, and by default it OPENS A PR
//                 and STOPS. A human reviews and merges. There is no planner
//                 (the issue is already chosen by the label event) and, in the
//                 default mode, no merge phase at all.
//
// FIRST-RUN SAFETY / AUTO-MERGE TOGGLE
// ------------------------------------
//   SANDCASTLE_AUTO_MERGE unset | "false"  (DEFAULT, safe):
//       implement -> review -> push branch + open a PR (open-pr-prompt.md).
//       Nothing is merged; the issue is NOT closed; a human merges the PR.
//   SANDCASTLE_AUTO_MERGE = "true"  (re-enable once the pilot is trusted):
//       implement -> review -> merge the branch into the checked-out base and
//       close the issue (the stock merge-prompt.md). NOTE: the stock merge
//       prompt's push-to-origin semantics are inherited from the engine and are
//       themselves verify-on-first-run — do not flip this on until the PR path
//       has been proven and you have confirmed how the merge lands on main.
//
// The toggle lives in ONE place (this env var, read below) and is documented in
// agent-implement.yml.
//
// Required env:
//   SANDCASTLE_ISSUE_NUMBER   the issue to work (github.event.issue.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write +
//                             issues:write (the App token in CI)
//
// Usage:
//   SANDCASTLE_ISSUE_NUMBER=123 npx tsx .sandcastle/agent-implement-issue.ts
//   # or: npm run sandcastle:implement   (with SANDCASTLE_ISSUE_NUMBER exported)
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const issueNumber = process.env.SANDCASTLE_ISSUE_NUMBER?.trim();
if (!issueNumber || !/^\d+$/.test(issueNumber)) {
  throw new Error(
    'SANDCASTLE_ISSUE_NUMBER must be set to a numeric issue number ' +
      `(got: ${JSON.stringify(process.env.SANDCASTLE_ISSUE_NUMBER)}).`
  );
}

// Default is PR mode. Auto-merge only when the flag is exactly "true".
const autoMerge = process.env.SANDCASTLE_AUTO_MERGE === 'true';

// Deterministic branch name, matching the planner's convention in main.ts so a
// re-run of the same issue reuses the same branch and accumulated progress.
const branch = `sandcastle/issue-${issueNumber}`;

// Fetch the issue title on the host so we can pass it to the prompts and name
// the PR. `gh` authenticates via GH_TOKEN in the environment.
const issueTitle = execFileSync(
  'gh',
  ['issue', 'view', issueNumber, '--json', 'title', '--jq', '.title'],
  { encoding: 'utf8' }
).trim();

// connector is an npm-workspaces monorepo: install with the committed
// package-lock.json (`npm ci`, the frozen-lockfile equivalent) so the sandbox
// resolves the exact dependency tree. Mirrors main.ts. We deliberately do NOT
// copyToWorktree node_modules — connector pulls platform-specific native
// modules (o1js WASM, libsql, bigint-buffer) that must resolve inside the
// Linux sandbox, not be copied from the host.
const hooks = {
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth DETERMINISTICALLY inside the container.
      //
      // ROOT CAUSE: @ai-hero/sandcastle@0.12.0 only configures git
      // `safe.directory` + `user.name`/`user.email` in the sandbox — it does
      // NO credential setup (verified in dist: `withSandboxLifecycle`). `gh`
      // authenticates from GH_TOKEN, but a bare `git push` uses git's own
      // credential system, which is not wired to the token. Pushes therefore
      // succeed only by luck (relay#70) and fail silently otherwise (store#50).
      //
      // `gh auth setup-git` installs `gh` as git's credential helper for
      // github.com in the container-global gitconfig, so every subsequent
      // `git push` reuses GH_TOKEN. The helper stores NO token in any file — it
      // shells out to `gh auth git-credential`, which reads GH_TOKEN at push
      // time. Guarded on GH_TOKEN so local dev without a token no-ops instead
      // of aborting sandbox setup (onSandboxReady failures are fatal).
      { command: 'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; fi' },
      // Install command is UNCHANGED — connector uses npm-workspaces (`npm ci`),
      // never pnpm. Only the auth line above is prepended.
      { command: 'npm ci' },
    ],
  },
};

console.log(`\n=== agent:implement runner — issue #${issueNumber} "${issueTitle}" ===`);
console.log(`Branch: ${branch}`);
console.log(
  `Mode:   ${autoMerge ? 'AUTO-MERGE (SANDCASTLE_AUTO_MERGE=true)' : 'PR (default — human merges)'}\n`
);

// ---------------------------------------------------------------------------
// Implement -> Review -> (open PR | merge)
// ---------------------------------------------------------------------------

async function main() {
  // Set to a non-null message in the PR-verification step below when the open-pr
  // phase reported success but no PR actually landed. We record it here (rather
  // than calling process.exit inside the try) so the `finally` still closes the
  // sandbox before we fail the job non-zero.
  let openPrVerificationError: string | null = null;

  const sandbox = await sandcastle.createSandbox({
    branch,
    // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN from the host into the container.
    // Without this the engine's env resolver never passes them through (they are
    // not in the gitignored `.sandcastle/.env`), so claude-code is "Not logged in"
    // and the in-sandbox `git push`/`gh pr create` are unauthenticated. See
    // ./sandbox-secrets.ts for the full root-cause note.
    sandbox: docker({ env: sandboxSecrets() }),
    hooks,
  });

  try {
    // Implement (opus, up to 100 iterations of the RED->GREEN->REFACTOR loop).
    const implement = await sandbox.run({
      name: 'implementer',
      maxIterations: 100,
      agent: sandcastle.claudeCode('claude-sonnet-5'),
      promptFile: './.sandcastle/implement-prompt.md',
      promptArgs: {
        TASK_ID: issueNumber,
        ISSUE_TITLE: issueTitle,
        BRANCH: branch,
      },
    });

    if (implement.commits.length === 0) {
      console.log(
        '\nImplementer produced no commits — nothing to open a PR for. ' +
          'Leaving the issue as-is. Inspect the logs, then remove/re-apply the ' +
          'agent:implement label to retry.'
      );
      process.exit(0);
    }

    // Review (opus, 1 iteration) on the SAME branch. The engine supplies the
    // built-in {{TARGET_BRANCH}} used inside review-prompt.md, so we pass only
    // BRANCH (mirrors main.ts).
    await sandbox.run({
      name: 'reviewer',
      maxIterations: 1,
      agent: sandcastle.claudeCode('claude-sonnet-5'),
      promptFile: './.sandcastle/review-prompt.md',
      promptArgs: { BRANCH: branch },
    });

    if (autoMerge) {
      // RE-ENABLE path: merge this one branch into the checked-out base and close
      // the issue, using the stock merge prompt scoped to the single branch.
      console.log('\nAuto-merge enabled — merging branch and closing issue.');
      await sandbox.run({
        name: 'merger',
        maxIterations: 1,
        agent: sandcastle.claudeCode('claude-opus-4-8'),
        promptFile: './.sandcastle/merge-prompt.md',
        promptArgs: {
          BRANCHES: `- ${branch}`,
          ISSUES: `- ${issueNumber}: ${issueTitle}`,
        },
      });
      console.log('\nMerge phase complete.');
    } else {
      // DEFAULT path: push the branch and open a PR for a human to review+merge.
      // Nothing is merged and the issue is NOT closed here.
      console.log('\nPR mode — pushing branch and opening a PR for human review.');
      await sandbox.run({
        name: 'open-pr',
        maxIterations: 1,
        agent: sandcastle.claudeCode('claude-sonnet-5'),
        promptFile: './.sandcastle/open-pr-prompt.md',
        promptArgs: {
          TASK_ID: issueNumber,
          ISSUE_TITLE: issueTitle,
          BRANCH: branch,
        },
      });
      // FAIL LOUD. The open-pr phase logs COMPLETE from the prompt regardless of
      // whether the in-sandbox `git push` / `gh pr create` actually succeeded, so
      // we must NOT trust it. Verify from the HOST (whose `gh` is authenticated
      // via GH_TOKEN) that an OPEN PR now exists for this branch. If not, dump the
      // push/PR state and exit non-zero so the Actions job FAILS instead of
      // green-lying (store#50: implementer committed, but push failed silently and
      // no PR was ever created, yet the job went green).
      const openPrs = JSON.parse(
        execFileSync(
          'gh',
          ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url'],
          { encoding: 'utf8' }
        )
      ) as Array<{ number: number; url: string }>;

      if (openPrs.length > 0) {
        const pr = openPrs[0]!;
        console.log(`\nVerified: PR #${pr.number} is open — ${pr.url}`);
        console.log('Awaiting human review.');
      } else {
        // No open PR. Gather diagnostics (all via the authenticated host `gh`).
        const nwo = execFileSync(
          'gh',
          ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
          { encoding: 'utf8' }
        ).trim();

        let branchPushed = false;
        try {
          execFileSync('gh', ['api', `repos/${nwo}/git/ref/heads/${branch}`], {
            stdio: 'pipe',
          });
          branchPushed = true;
        } catch {
          branchPushed = false;
        }

        const anyStatePrs = execFileSync(
          'gh',
          ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url'],
          { encoding: 'utf8' }
        ).trim();

        openPrVerificationError =
          `\nERROR: the open-pr phase reported COMPLETE, but no OPEN PR exists ` +
          `for branch '${branch}'.\n` +
          `  Remote branch pushed to origin: ${branchPushed}\n` +
          `  PRs for this branch (any state): ${anyStatePrs}\n` +
          `  The in-sandbox \`git push\` and/or \`gh pr create\` failed ` +
          `silently. Inspect the open-pr phase logs above. The Actions job is ` +
          `failing deliberately so this is not mistaken for success.`;
      }
    }
  } finally {
    await sandbox.close();
  }

  // Fail loud AFTER the sandbox is closed: a silently-failed push/PR-create must
  // turn the Actions job red, never green.
  if (openPrVerificationError) {
    console.error(openPrVerificationError);
    process.exit(1);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
