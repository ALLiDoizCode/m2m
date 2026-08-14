// Single-PR repair runner — the entry point the `agent:fix` label→runner
// workflow (.github/workflows/agent-fix.yml) invokes when the PR repair pass
// (toon-meta#357, toon-meta's scripts/factory/{repair,automerge}-evaluator.mjs
// + auto-merge.mjs) applies `agent:fix` to a PR whose ONLY blocker(s) are red
// checks and/or a merge conflict.
//
// Ported from toon-meta's .sandcastle/agent-fix-pr.ts (toon-meta#365 fan-out),
// adapted to connector's conventions. Mirrors ./agent-review-pr.ts's single-PR
// mechanics (fetch the PR head as a local branch, run one sandboxed agent pass
// against it, push any commits back to the SAME PR — never a new one),
// swapping the reviewer role for a fixer role (sonnet, up to 60 iterations —
// a repair is scoped and bounded by the evaluator's own retry/repair budgets,
// DEFAULT_REPAIR_BUDGET = 2, so this runner does not also need implement's
// full iteration budget).
//
// THE LOAD-BEARING PART (toon-meta#357's own words): this runner REMOVES its
// own `agent:fix` label when it finishes, WHATEVER THE OUTCOME (fix pushed, no
// changes made, or the run itself threw) — never only on success. Three labels
// have already been found that an automated step applies and nothing automated
// clears: `agent:implement` (toon-meta#330), `needs:human` (toon-meta#352),
// `agent:review` (toon-meta#355). This must not become a fourth. Removing the
// label unconditionally also re-arms the repair evaluator's
// `hasAgentFixInFlight` gate, so the NEXT auto-merge pass evaluates this PR
// fresh (still red → another `repair` attempt against the budget, or
// `escalate` once the budget is spent — never silently stuck "in flight"
// forever).
//
// RESIDUAL GAP, stated rather than hidden: "whatever the outcome" covers every
// outcome of THIS PROCESS — the outermost `finally` runs whether the fixer
// pushed, changed nothing, or threw. It cannot cover the process never getting
// that far: a throw in the setup above it (the `gh pr view` / `git fetch`
// before the try), or a job-level kill (the step timeout, a cancel). Those
// leave `agent:fix` on the PR, and nothing else clears it — the same exposure
// `agent-review-pr.ts` has for `agent:review`.
//
// STANDALONE MECHANICS: same worktree conflict agent-review-pr.ts documents
// (sandcastle checks the PR head out in its own worktree, so the workflow
// checks out `main` and this runner materialises the PR head as a local branch
// itself before createSandbox()).
//
// PUSH CREDENTIAL: the fix commits are pushed with a FRESHLY MINTED App
// installation token (./mint-app-token.ts, connector#462/#463 pattern) staged
// into the container at push time — installation tokens expire after ONE HOUR,
// and a repair run that spends its budget compiling the Rust gate must not die
// at the very last step with a dead credential.
//
// This runner NEVER submits a review verdict and NEVER merges — it only pushes
// fix commits back to the PR. The existing review pass (agent:review) and
// auto-merge pass re-evaluate the PR on its own `synchronize` trigger.
//
// Required env:
//   SANDCASTLE_PR_NUMBER      the PR to repair (github.event.pull_request.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write +
//                             issues:write (labels)
//   APP_ID, APP_PRIVATE_KEY   for minting a fresh push credential mid-run
//                             (#462). HOST-ONLY: sandbox-secrets.ts forwards
//                             only CLAUDE_CODE_OAUTH_TOKEN and GH_TOKEN.
//
// Usage:
//   SANDCASTLE_PR_NUMBER=42 npx tsx .sandcastle/agent-fix-pr.ts
//   # or: npm run sandcastle:fix   (with SANDCASTLE_PR_NUMBER exported)
//
// CJS NOTE: connector's root package.json has no `"type": "module"` (it is a
// CJS npm-workspaces repo), so tsx/esbuild transforms this runner to CommonJS,
// where top-level `await` is a compile error. The async body therefore lives in
// `main()` and is invoked below WITHOUT top-level await. Do NOT reintroduce
// top-level await here. (Same note as ./agent-review-pr.ts.)

import { execFileSync } from 'node:child_process';
import * as sandcastle from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { sandboxSecrets } from './sandbox-secrets.ts';
import { mintAppToken } from './mint-app-token.ts';

// Deliberately a LOCAL constant: .sandcastle/ is what gets fanned out to every
// fleet repo, so this runner must work standalone here without toon-meta-only
// helpers. Mirrors AGENT_REVIEW_LABEL's own local definition in
// review-verdict.ts, one file over.
const AGENT_FIX_LABEL = 'agent:fix';

const prNumber = process.env.SANDCASTLE_PR_NUMBER?.trim();
if (!prNumber || !/^\d+$/.test(prNumber)) {
  throw new Error(
    'SANDCASTLE_PR_NUMBER must be set to a numeric PR number ' +
      `(got: ${JSON.stringify(process.env.SANDCASTLE_PR_NUMBER)}).`
  );
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function repoNwo(): string {
  return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

/**
 * Remove `agent:fix` from the PR. Idempotent: a 404 (label absent — a prior
 * pass already cleared it, or this is a re-run) is the expected no-op and must
 * not fail the job; any other error still throws, matching review-verdict.ts's
 * `agent:review` clear (toon-meta#355) — silently losing this removal would
 * recreate the exact stuck-label problem toon-meta#357 exists to fix.
 */
function removeAgentFixLabel(): void {
  const nwo = repoNwo();
  try {
    execFileSync(
      'gh',
      [
        'api',
        '-X',
        'DELETE',
        // The colon MUST stay percent-encoded — `gh api` does not encode path
        // segments, and an unencoded `agent:fix` silently no-ops (200, label
        // untouched). Same gotcha documented in review-verdict.ts.
        `repos/${nwo}/issues/${prNumber}/labels/${encodeURIComponent(AGENT_FIX_LABEL)}`,
      ],
      { stdio: 'pipe' }
    );
    console.log(`Cleared '${AGENT_FIX_LABEL}' on PR #${prNumber} — repair run finished.`);
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    if (!/\b404\b|Not Found/i.test(stderr)) {
      if (stderr) process.stderr.write(stderr);
      throw error;
    }
    console.log(`'${AGENT_FIX_LABEL}' was not on PR #${prNumber} — nothing to clear.`);
  }
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

// Materialise the PR head as a local branch at origin's tip (the host clone is
// on main — see the standalone mechanics note above). Forced so a re-labeled
// PR re-repairs the CURRENT head even after a force-push.
execFileSync('git', ['fetch', 'origin', `+${headRef}:${headRef}`], {
  stdio: 'inherit',
});

// connector is an npm-workspaces monorepo — install with the committed
// package-lock.json (`npm ci`). Mirrors agent-review-pr.ts / main.ts.
const hooks = {
  sandbox: {
    onSandboxReady: [
      // Same git-push-auth wiring as agent-review-pr.ts / agent-implement-issue.ts
      // — see either file's onSandboxReady for the full root-cause note.
      {
        command:
          'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; ' +
          "git config --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true; fi",
      },
      // Install command UNCHANGED (npm-workspaces `npm ci`, not pnpm).
      { command: 'npm ci' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Pushing with a credential that is fresh AT THE MOMENT OF THE PUSH (#462) —
// same mechanics as agent-implement-issue.ts's pushBranch(); see that file for
// the full rationale (empty `credential.helper=` reset is load-bearing, token
// staged via stdin so it appears in no argv and no log line).
// ---------------------------------------------------------------------------

/** Where the fresh token is staged inside the container. Mode 600, deleted after use. */
const TOKEN_PATH = '/tmp/.sandcastle-push-token';

const FRESH_CREDENTIAL_HELPER =
  `!f() { test "$1" = get && ` +
  `{ echo username=x-access-token; echo "password=$(cat ${TOKEN_PATH})"; }; }; f`;

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

/** Push the PR head branch from inside the sandbox with a newly-minted token. Fails loud. */
async function pushFixCommits(sandbox: Sandbox): Promise<void> {
  const minted = await mintAppToken();
  // Keep the host in step with the container (the verification `gh api` calls
  // below run on the same one-hour clock).
  process.env.GH_TOKEN = minted.token;
  console.log(`  [push] credential: freshly minted (source=${minted.source})`);

  // `umask 077` so the file is 600 from creation — never briefly world-readable.
  const stage = await sandbox.exec(`umask 077 && cat > ${TOKEN_PATH}`, {
    stdin: minted.token,
  });
  if (stage.exitCode !== 0) {
    throw new Error(`Failed to stage the push credential (exit ${stage.exitCode}).`);
  }

  try {
    const push = await sandbox.exec(
      `git -c credential.helper= -c credential.helper='${FRESH_CREDENTIAL_HELPER}' ` +
        `push origin ${headRef}`,
      { onLine: (line) => console.log(`  [push] ${line}`) }
    );
    if (push.exitCode !== 0) {
      throw new Error(`git push of '${headRef}' failed (exit ${push.exitCode}).\n${push.stderr}`);
    }
  } finally {
    // Do not leave a usable credential on disk in the container.
    await sandbox.exec(`rm -f ${TOKEN_PATH}`);
  }
}

console.log(`\n=== agent:fix runner — PR #${prNumber} (head: ${headRef}) ===\n`);

async function main() {
  // Set to a non-null message in the push-verification step below when the
  // fixer reported commits but the PR branch did NOT actually advance.
  // Recorded here (rather than process.exit inside the try) so the finally
  // blocks below still close the sandbox and clear the label before we fail
  // the job.
  let pushVerificationError: string | null = null;

  try {
    const sandbox = await sandcastle.createSandbox({
      branch: headRef,
      // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN into the container — see
      // ./sandbox-secrets.ts. APP_ID/APP_PRIVATE_KEY stay on the host.
      sandbox: docker({ env: sandboxSecrets() }),
      hooks,
    });

    try {
      const fix = await sandbox.run({
        name: 'fixer',
        // Scoped to a bounded repair, not a full implement — the evaluator's
        // own DEFAULT_REPAIR_BUDGET (2 agent:fix dispatches per PR) is what
        // actually bounds retries across runs; this just keeps ONE run from
        // wandering indefinitely.
        maxIterations: 60,
        agent: sandcastle.claudeCode('claude-sonnet-5'),
        promptFile: './.sandcastle/fix-prompt.md',
        promptArgs: {
          PR_NUMBER: prNumber,
          BRANCH: headRef,
        },
      });

      if (fix.commits.length > 0) {
        console.log(`\nFixer made ${fix.commits.length} commit(s) — pushing to the PR branch.`);
        // DETERMINISTIC (no agent) — same rationale as the review/implement
        // runners' push step: `git push` is pure plumbing with no judgement
        // call, so it is run directly rather than handed to another agent
        // pass. Credential minted fresh immediately before the push (#462).
        await pushFixCommits(sandbox);

        // FAIL LOUD: verify from the HOST that the PR branch head now points
        // at the fixer's last commit.
        const expectedSha = fix.commits[fix.commits.length - 1]!.sha;
        const nwo = repoNwo();
        const remoteSha = JSON.parse(
          execFileSync('gh', ['api', `repos/${nwo}/git/ref/heads/${headRef}`], {
            encoding: 'utf8',
          })
        ).object?.sha as string | undefined;

        if (remoteSha === expectedSha) {
          console.log(
            `\nVerified: PR branch '${headRef}' advanced to ${expectedSha} (the fix commits are pushed).`
          );
          // Re-arm the verdict loop (found live by the 2026-08-14 drill on
          // toon-meta#381): the fix push creates a NEW head, the factory-ops
          // approval stays anchored to the OLD one, and the auto-merge
          // evaluator's approval-staleness guard then blocks the PR forever —
          // nothing re-reviews on its own, because `agent:review` was cleared
          // when the previous verdict landed (toon-meta#355). Applying it
          // here fires the review pass on the repaired head, and a clean
          // verdict re-opens the merge chain. Best-effort by design: if this
          // fails, the PR sits approval-stale until a human applies the label
          // — worse observability, no wrong writes — so log loudly, never
          // throw (the fix itself is already pushed and verified).
          try {
            execFileSync(
              'gh',
              [
                'api',
                '-X',
                'POST',
                `repos/${nwo}/issues/${prNumber}/labels`,
                '-f',
                'labels[]=agent:review',
              ],
              { stdio: ['ignore', 'ignore', 'inherit'] }
            );
            console.log(
              `Applied 'agent:review' to PR #${prNumber} — the repaired head needs a fresh verdict.`
            );
          } catch (error) {
            console.log(
              `::warning::PR #${prNumber}: fix pushed, but applying 'agent:review' failed — ` +
                `the PR will sit approval-stale until the label is applied by hand. ${String(error)}`
            );
          }
        } else {
          pushVerificationError =
            `\nERROR: the fix phase reported COMPLETE, but the PR branch ` +
            `'${headRef}' did NOT advance to the fixer's commits.\n` +
            `  Expected head SHA (last fix commit): ${expectedSha}\n` +
            `  Actual remote head SHA:              ${remoteSha ?? '<branch not found>'}\n` +
            `  The in-sandbox \`git push\` failed silently. Inspect the fixer ` +
            `phase logs above. The Actions job is failing deliberately so this ` +
            `is not mistaken for success.`;
        }
      } else {
        console.log(
          '\nFixer made no changes — either the PR was not actually fixable ' +
            'from this branch, or it determined nothing needed changing.'
        );
      }
    } finally {
      await sandbox.close();
    }
  } finally {
    // ALWAYS clear agent:fix, even if the run above threw — see the module
    // header. This must be the LAST thing that can be skipped by an exception,
    // so it lives in the outermost finally.
    removeAgentFixLabel();
  }

  // Fail loud AFTER the sandbox is closed and the label is cleared: a
  // silently-failed push must turn the Actions job red, never green.
  if (pushVerificationError) {
    console.error(pushVerificationError);
    process.exit(1);
  }

  console.log(
    '\nRepair run complete. The PR was NOT merged and NOT re-reviewed here — ' +
      'its own `synchronize` trigger re-evaluates auto-merge and, if `agent:review` ' +
      'was already applied, the review pass.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
