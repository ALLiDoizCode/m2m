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
//   APP_ID, APP_PRIVATE_KEY   the same GitHub App the workflow mints GH_TOKEN
//                             from. Used to mint a FRESH token immediately
//                             before each push, because installation tokens
//                             expire after one hour and long runs pushed with a
//                             dead credential — see #462 and ./mint-app-token.ts.
//                             HOST ONLY: the private key is deliberately absent
//                             from PASSTHROUGH_KEYS in ./sandbox-secrets.ts, so
//                             it never enters the sandbox container. Optional —
//                             without it the runner falls back to the ambient
//                             GH_TOKEN and the old expiry behaviour.
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
import { mintAppToken } from './mint-app-token.ts';
import { fixPrompt, runGate, selectSteps } from './run-gate.ts';

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

// How many times a red gate may be handed back for a fix before the run fails.
// Two is deliberate: the failures this catches are overwhelmingly small compile
// or lint errors that one iteration fixes. A larger budget mostly buys a longer
// run before the same loud failure.
const MAX_GATE_FIX_ATTEMPTS = 2;

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
      {
        command:
          'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; ' +
          "git config --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true; fi",
      },
      // Install command is UNCHANGED — connector uses npm-workspaces (`npm ci`),
      // never pnpm. Only the auth line above is prepended.
      { command: 'npm ci' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Pushing with a credential that is fresh AT THE MOMENT OF THE PUSH (#462)
// ---------------------------------------------------------------------------

/** Where the fresh token is staged inside the container. Mode 600, deleted after use. */
const TOKEN_PATH = '/tmp/.sandcastle-push-token';

// Git credential helper that reads the token from TOKEN_PATH at push time.
//
// The leading `!` makes git run this as a shell snippet. The empty
// `credential.helper=` that precedes it on the command line is load-bearing: git
// treats credential.helper as a MULTI-VALUED config key and an empty value
// RESETS the list, which is what stops `gh auth setup-git`'s container-global
// helper (wired in onSandboxReady, and holding the STALE token from container
// start) from being consulted first and winning.
//
// The token reaches the container via `stdin`, and is read back from a file
// rather than interpolated into the command, so it appears in no argv, no
// process listing, and no captured log line.
const FRESH_CREDENTIAL_HELPER =
  `!f() { test "$1" = get && ` +
  `{ echo username=x-access-token; echo "password=$(cat ${TOKEN_PATH})"; }; }; f`;

/**
 * Push `branch` from inside the sandbox using a newly-minted App token.
 *
 * Also refreshes the HOST's `GH_TOKEN` from the same mint, because the host `gh`
 * calls that follow (`pr list`, `pr create`, `api`) authenticate from
 * `process.env` and expire on exactly the same one-hour clock.
 *
 * `bestEffort` is for the early publish after the implementer phase: a failure
 * there costs us recoverability but must not abandon a run that still has a
 * review phase to do. The final push is never best-effort — it fails loud.
 */
type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

async function pushBranch(
  sandbox: Sandbox,
  label: string,
  { bestEffort = false }: { bestEffort?: boolean } = {}
): Promise<boolean> {
  let token: string;
  try {
    const minted = await mintAppToken();
    token = minted.token;
    // Keep the host in step with the container.
    process.env.GH_TOKEN = token;
    console.log(`  [${label}] credential: freshly minted (source=${minted.source})`);
  } catch (err) {
    const msg = `[${label}] could not obtain a push credential: ${(err as Error).message}`;
    if (bestEffort) {
      console.warn(`  WARNING: ${msg}`);
      return false;
    }
    throw new Error(msg);
  }

  // `umask 077` so the file is 600 from creation — never briefly world-readable.
  const stage = await sandbox.exec(`umask 077 && cat > ${TOKEN_PATH}`, { stdin: token });
  if (stage.exitCode !== 0) {
    const msg = `[${label}] failed to stage the push credential (exit ${stage.exitCode}).`;
    if (bestEffort) {
      console.warn(`  WARNING: ${msg}`);
      return false;
    }
    throw new Error(msg);
  }

  try {
    const push = await sandbox.exec(
      `git -c credential.helper= -c credential.helper='${FRESH_CREDENTIAL_HELPER}' ` +
        `push -u origin ${branch}`,
      { onLine: (line) => console.log(`  [${label}] ${line}`) }
    );
    if (push.exitCode !== 0) {
      const msg = `[${label}] git push of '${branch}' failed (exit ${push.exitCode}).\n${push.stderr}`;
      if (bestEffort) {
        console.warn(`  WARNING: ${msg}`);
        return false;
      }
      throw new Error(msg);
    }
    return true;
  } finally {
    // Do not leave a usable credential on disk in the container for the agent
    // phases that follow.
    await sandbox.exec(`rm -f ${TOKEN_PATH}`);
  }
}

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

    // PUBLISH EARLY (#462). The implementer has committed; get those commits onto
    // origin NOW rather than after the reviewer. Two reasons:
    //   1. Recoverability — a run that dies during review (timeout, cancellation,
    //      runner death) leaves the completed implementation on a remote branch
    //      instead of losing it with the container. Three runs' worth of work was
    //      lost this way before this existed (#422 twice, #430 once).
    //   2. It is the cheapest moment to fail: if push auth is broken we learn it
    //      here, minutes in, not an hour later.
    // Best-effort: a failure is a warning, because the review phase is still
    // worth running and the final push below fails loud.
    console.log('\nPublishing the implementer branch early (crash-recovery point).');
    await pushBranch(sandbox, 'push:early', { bestEffort: true });

    // GATE — run by the runner, not asked of the agent.
    //
    // implement-prompt.md says "Do not commit until lint, typecheck, build, and
    // test all pass", but that is advisory prose the agent self-reports on, and
    // it named only the npm gate — no `cargo` at all — while the #409 rewrite is
    // Rust. #441, #444, #446, #449 and #454 are the receipts: five remediation
    // tickets in one epic for PRs that did not compile, every one discovered
    // only after CI ran. Same failure mode toon-meta#235 fixed for `git push`,
    // same cure: verifying a build is plumbing, so the runner does it.
    //
    // A red gate gets up to MAX_GATE_FIX_ATTEMPTS fix iterations with the exact
    // failure output fed back, because these are overwhelmingly small compile
    // errors that are cheap to fix now and expensive to discover later. Still
    // red after that: push what exists and fail the job loudly, never open a PR
    // on a known-red branch.
    const gateSteps = await selectSteps(sandbox, 'main');
    let gate = await runGate(sandbox, gateSteps);

    for (let attempt = 1; !gate.passed && attempt <= MAX_GATE_FIX_ATTEMPTS; attempt++) {
      console.log(`\nGate is red — fix attempt ${attempt}/${MAX_GATE_FIX_ATTEMPTS}.`);
      await sandbox.run({
        name: `gate-fix-${attempt}`,
        maxIterations: 20,
        agent: sandcastle.claudeCode('claude-sonnet-5'),
        prompt: fixPrompt(gate.failure!, attempt, MAX_GATE_FIX_ATTEMPTS),
      });
      // Push after each attempt so the work survives even if the next step dies.
      await pushBranch(sandbox, `push:gate-fix-${attempt}`, { bestEffort: true });
      gate = await runGate(sandbox, gateSteps);
    }

    if (!gate.passed) {
      throw new Error(
        `Gate still RED after ${MAX_GATE_FIX_ATTEMPTS} fix attempt(s) — refusing to open a PR.\n` +
          `  Failing step: ${gate.failure!.step}\n` +
          `  Command:      ${gate.failure!.command} (exit ${gate.failure!.exitCode})\n` +
          `Branch '${branch}' has been pushed, so the work is recoverable. ` +
          `Inspect the agent log artifact, fix it, or re-run the issue.\n\n` +
          gate.failure!.output
      );
    }

    // Review (opus, 1 iteration) on the SAME branch. The engine supplies the
    // built-in {{TARGET_BRANCH}} used inside review-prompt.md, so we pass only
    // BRANCH (mirrors main.ts).
    await sandbox.run({
      name: 'reviewer',
      maxIterations: 1,
      agent: sandcastle.claudeCode('claude-opus-5'),
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
        agent: sandcastle.claudeCode('claude-opus-5'),
        promptFile: './.sandcastle/merge-prompt.md',
        promptArgs: {
          BRANCHES: `- ${branch}`,
          ISSUES: `- ${issueNumber}: ${issueTitle}`,
        },
      });
      console.log('\nMerge phase complete.');
    } else {
      // DEFAULT path: publish the branch and open a PR for a human to review+merge.
      // Nothing is merged and the issue is NOT closed here.
      //
      // DETERMINISTIC (no agent) — see toon-meta#235. The former open-pr agent
      // (open-pr-prompt.md) reported COMPLETE without reliably running the push
      // (only 4/19 PRs landed on the 2026-07-23 gate re-run wave). git push +
      // gh pr create are pure plumbing: push from INSIDE the sandbox (commits live
      // there; gh auth setup-git wired the credential helper in onSandboxReady),
      // open the PR from the authenticated HOST. sandbox.exec() surfaces a
      // non-zero exitCode (it does NOT throw) — check it and fail loud.
      //
      // The credential is minted fresh here, immediately before the push, so the
      // run's total length is irrelevant (#462). This also refreshes the host's
      // GH_TOKEN, which the `gh` calls below depend on.
      console.log('\nPR mode — pushing branch and opening a PR for human review.');

      await pushBranch(sandbox, 'push:final');

      const alreadyOpen = JSON.parse(
        execFileSync(
          'gh',
          ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'],
          { encoding: 'utf8' }
        )
      ) as Array<{ number: number }>;
      if (alreadyOpen.length === 0) {
        const body =
          'Produced by the sandcastle `agent:implement` runner; awaiting human ' +
          `review.\n\nCloses #${issueNumber}\n\n` +
          '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
        execFileSync(
          'gh',
          [
            'pr',
            'create',
            '--base',
            'main',
            '--head',
            branch,
            '--title',
            issueTitle,
            '--body',
            body,
          ],
          { stdio: 'inherit' }
        );
      }
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
