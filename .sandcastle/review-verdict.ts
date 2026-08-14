// Reviewer verdict channel (toon-meta#275) — shared by the implement runner's
// review phase (agent-implement-issue.ts) and the standalone review runner
// (agent-review-pr.ts).
//
// WHY THIS MODULE DOES ITS OWN EXTRACTION (verified against the published
// @ai-hero/sandcastle@0.12.0 dist):
//   - The engine's structured-output surface — `Output.object({ tag, schema })`,
//     fence-aware tag extraction, `StructuredOutputError`, `maxRetries` via
//     session resume — exists ONLY on the top-level `run()` entry point
//     (dist/index.js `run()`; see engine ADR 0010). The long-lived
//     `sandbox.run()` the runners use accepts NO `output` option: the runtime
//     never reads it and the option would be silently ignored.
//   - We therefore declare the exact `Output.object` definition the ticket
//     specifies (`reviewOutput` below) and consume its tag + schema OURSELVES,
//     mirroring the engine's extraction semantics precisely: the LAST
//     `<review>…</review>` block in the run's stdout wins, ```json fences are
//     unwrapped, the contents are JSON-parsed and schema-validated.
//   - The retry mirrors the engine's `maxRetries` design: on a malformed
//     verdict, `SandboxRunResult.resume()` continues the reviewer's captured
//     session for exactly one iteration with a token-efficient description of
//     the parse/validation error (the engine's own structured-output retry
//     mechanism). ONE retry, then FAIL: a malformed verdict must fail the job,
//     never pass silently (toon-meta#275 acceptance criterion).
//   - `resume()` gotcha: it spreads the ORIGINAL runOptions (including
//     promptArgs) into an inline-prompt run, and the engine rejects non-empty
//     promptArgs on inline prompts — so the retry passes `promptArgs: {}`
//     explicitly.

import { execFileSync } from 'node:child_process';
import * as sandcastle from '@ai-hero/sandcastle';
import { z } from 'zod';
import { shouldClearNeedsHuman } from './needs-human-evaluator.mjs';

// ---------------------------------------------------------------------------
// Schema + Output declaration
// ---------------------------------------------------------------------------

export const reviewVerdictSchema = z
  .object({
    verdict: z.enum(['clean', 'blocking']),
    blockingFindings: z.array(
      z.object({
        /** Repo-relative path of the file the finding is about. */
        file: z.string().min(1),
        /** 1-based line number, or null for a file-level finding. */
        line: z.number().int().min(1).nullable(),
        /** One-line description of the defect. */
        summary: z.string().min(1),
        /** Why this blocks the merge (which criterion/behaviour it violates). */
        why: z.string().min(1),
      })
    ),
  })
  .superRefine((value, ctx) => {
    if (value.verdict === 'blocking' && value.blockingFindings.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a blocking verdict requires at least one blockingFinding',
      });
    }
    if (value.verdict === 'clean' && value.blockingFindings.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a clean verdict must carry zero blockingFindings',
      });
    }
  });

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/**
 * The structured-output declaration toon-meta#275 specifies. `sandbox.run()`
 * cannot consume it (see module header), so `extractReviewVerdict()` consumes
 * its tag + schema instead. Keeping the declaration in the engine's own shape
 * means the runners can hand it straight to top-level `run({ output })` if the
 * engine ever exposes structured output on the sandbox surface.
 */
export const reviewOutput = sandcastle.Output.object({
  tag: 'review',
  schema: reviewVerdictSchema,
});

// ---------------------------------------------------------------------------
// Extraction — mirrors the engine's extractStructuredOutput() semantics
// ---------------------------------------------------------------------------

/** Last `<tag>…</tag>` content in `text`, engine-identical scan. */
function findLastTagContent(text: string, tag: string): string | undefined {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let lastContent: string | undefined;
  let searchFrom = 0;
  for (;;) {
    const openIdx = text.indexOf(openTag, searchFrom);
    if (openIdx === -1) break;
    const contentStart = openIdx + openTag.length;
    const closeIdx = text.indexOf(closeTag, contentStart);
    if (closeIdx === -1) break;
    lastContent = text.slice(contentStart, closeIdx);
    searchFrom = closeIdx + closeTag.length;
  }
  return lastContent;
}

/** Engine-identical ```/```json fence unwrap. */
function unwrapFences(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return fenceMatch ? fenceMatch[1]!.trim() : text;
}

export type VerdictAttempt = { ok: true; verdict: ReviewVerdict } | { ok: false; error: string };

/** Extract + validate the `<review>` verdict from a reviewer run's stdout. */
export function extractReviewVerdict(stdout: string): VerdictAttempt {
  const raw = findLastTagContent(stdout, reviewOutput.tag);
  if (raw === undefined) {
    return {
      ok: false,
      error: `structured output tag <${reviewOutput.tag}> not found in the reviewer's output`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapFences(raw.trim()));
  } catch (cause) {
    return {
      ok: false,
      error:
        `tag <${reviewOutput.tag}> contains invalid JSON ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Matched content: ${raw.trim().slice(0, 500)}`,
    };
  }
  const result = reviewVerdictSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error:
        `tag <${reviewOutput.tag}> failed schema validation: ` +
        result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, verdict: result.data };
}

// ---------------------------------------------------------------------------
// Reviewer run with enforced verdict
// ---------------------------------------------------------------------------

export interface TargetIssue {
  /** Issue number as a string, e.g. "275". */
  number: string;
  title: string;
}

/** Mirrors the engine's buildStructuredOutputRetryFeedback() wording. */
function buildRetryFeedback(error: string): string {
  return (
    `Your previous response did not produce a valid structured review verdict.\n\n` +
    `Retries remaining after this attempt: 0.\n\n` +
    `Problem:\n${error}\n\n` +
    `Emit only a corrected <review> block — JSON matching\n` +
    `{"verdict":"clean"|"blocking","blockingFindings":[{"file":string,` +
    `"line":number|null,"summary":string,"why":string}]}\n` +
    `— and nothing else. Do not change files or run commands.`
  );
}

/**
 * Run the reviewer (opus, single iteration) on `branch` and REQUIRE the
 * structured verdict. On a malformed verdict, retries exactly once by resuming
 * the reviewer's session (the engine's structured-output retry mechanism); if
 * the verdict is still malformed, THROWS so the job fails rather than passing
 * silently.
 */
export async function runReviewerWithVerdict(
  sandbox: sandcastle.Sandbox,
  options: {
    branch: string;
    /** null → no target issue; the prompt skips the Spec axis. */
    issue: TargetIssue | null;
    promptFile?: string;
  }
): Promise<{ verdict: ReviewVerdict; commits: { sha: string }[] }> {
  const first = await sandbox.run({
    name: 'reviewer',
    maxIterations: 1,
    agent: sandcastle.claudeCode('claude-opus-5'),
    promptFile: options.promptFile ?? './.sandcastle/review-prompt.md',
    promptArgs: {
      BRANCH: options.branch,
      ISSUE_NUMBER: options.issue?.number ?? 'none',
      ISSUE_TITLE: options.issue?.title ?? '(no target issue resolved)',
    },
  });

  const commits = [...first.commits];
  let attempt = extractReviewVerdict(first.stdout);

  if (!attempt.ok) {
    console.warn(
      `\nReviewer verdict malformed (${attempt.error}) — retrying once via session resume.`
    );
    if (!first.resume) {
      throw new Error(
        `Reviewer emitted a malformed <review> verdict and the session cannot ` +
          `be resumed (no captured session id) — failing the run. ` +
          `Detail: ${attempt.error}`
      );
    }
    // promptArgs MUST be reset: resume() re-spreads the original run options,
    // and inline prompts reject non-empty promptArgs (see module header).
    const retry = await first.resume(buildRetryFeedback(attempt.error), {
      name: 'reviewer-verdict-retry',
      promptArgs: {},
    });
    commits.push(...retry.commits);
    attempt = extractReviewVerdict(retry.stdout);
    if (!attempt.ok) {
      throw new Error(
        `Reviewer verdict still malformed after one resume retry — failing ` +
          `the run so a missing verdict is never mistaken for a clean one. ` +
          `Detail: ${attempt.error}`
      );
    }
  }

  const { verdict } = attempt;
  console.log(
    `\nReviewer verdict: ${verdict.verdict.toUpperCase()}` +
      (verdict.blockingFindings.length > 0
        ? ` (${verdict.blockingFindings.length} blocking finding(s))`
        : '')
  );
  return { verdict, commits };
}

// ---------------------------------------------------------------------------
// Host-side helpers (authenticated `gh` via GH_TOKEN)
// ---------------------------------------------------------------------------

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function repoNwo(): string {
  return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

/**
 * Resolve the target issue for a PR from its body's closing keyword
 * (`Closes #n` / `Fixes #n` / `Resolves #n`, same-repo only — the convention
 * the implement runner writes into every factory PR body). Returns null when
 * no closing reference exists or the referenced issue cannot be read; the
 * reviewer then skips the Spec axis rather than failing.
 */
export function resolveIssueFromPrBody(prNumber: string): TargetIssue | null {
  const body = gh(['pr', 'view', prNumber, '--json', 'body', '--jq', '.body']);
  const match = body.match(
    /\b(?:clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))[ \t]*:?[ \t]+#(\d+)/i
  );
  if (!match) return null;
  const number = match[1]!;
  try {
    const title = gh(['issue', 'view', number, '--json', 'title', '--jq', '.title']).trim();
    return { number, title };
  } catch {
    console.warn(
      `PR body references #${number} but the issue could not be read — ` + `skipping the Spec axis.`
    );
    return null;
  }
}

const NEEDS_HUMAN_LABEL = 'needs:human';
const AGENT_REVIEW_LABEL = 'agent:review';

// ---------------------------------------------------------------------------
// factory-ops formal verdict (toon-meta#282)
//
// The factory App (toon-backlog-bot) opens agent PRs, and GitHub forbids a
// PR's author from approving it — so the formal review verdict is submitted by
// a SECOND identity: factory-ops, authenticating via the FACTORY_OPS_TOKEN
// org secret (provisioned + monitored under toon-meta#271,
// .github/workflows/factory-ops-credential.yml).
//
//   clean    → a real APPROVE review (satisfies required-review protection)
//   blocking → a REQUEST_CHANGES review carrying the findings, + needs:human
//
// The approval is a MACHINE verdict: it attests that the gate passed and the
// reviewer found nothing blocking — not human judgement. See FACTORY.md,
// "What a factory-ops approval attests".
//
// FAIL LOUDLY, NEVER DEGRADE: if the token is missing (an unshared org secret
// is an EMPTY STRING at runtime, not an error), does not authenticate
// (expired/revoked/pending org approval), or authenticates AS the PR author,
// every function here THROWS so the job goes red. The retired loops' reviewer
// rotted precisely because REVIEWER_TOKEN expired and reviews silently
// degraded to a COMMENTED verdict that satisfied nothing — that degradation
// path must not exist here, so the submitted review's state is also read back
// and verified.
// ---------------------------------------------------------------------------

export interface FactoryOpsIdentity {
  /** The FACTORY_OPS_TOKEN value, used as GH_TOKEN for verdict submission. */
  token: string;
  /** The login the token authenticates as, e.g. "ALLiDoizCode". */
  login: string;
}

/**
 * Normalize an actor login for identity comparison. The same App author
 * renders as `app/toon-backlog-bot` via GraphQL (`gh pr view --json author`)
 * and `toon-backlog-bot[bot]` via REST — strip both decorations and casing so
 * the self-approval guard cannot be dodged by a representation mismatch.
 */
export function normalizeLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/^app\//, '')
    .replace(/\[bot\]$/, '');
}

/**
 * Resolve the factory-ops approver identity, or THROW (fail the job) when the
 * credential is missing or does not authenticate. Call this as early as
 * possible — a rotten credential should fail the run before an expensive
 * reviewer pass, not after it.
 */
export function resolveFactoryOpsIdentity(): FactoryOpsIdentity {
  const token = process.env.FACTORY_OPS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      `FACTORY_OPS_TOKEN is missing or empty. The formal review verdict ` +
        `(toon-meta#282) cannot be submitted without the factory-ops identity. ` +
        `An org secret that is not shared with this repository is an empty ` +
        `string at runtime, not an error — check org Settings -> Secrets and ` +
        `variables -> Actions -> FACTORY_OPS_TOKEN -> Repository access, and ` +
        `the workflow step's env wiring. Failing loudly instead of degrading ` +
        `to a COMMENTED verdict (that silent degradation is how the retired ` +
        `loops' reviewer rotted when REVIEWER_TOKEN expired).`
    );
  }
  let login = '';
  try {
    login = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: token },
    }).trim();
  } catch {
    login = '';
  }
  if (!login) {
    throw new Error(
      `FACTORY_OPS_TOKEN did not authenticate. It may be revoked, expired, or ` +
        `still pending org approval (a fine-grained PAT against an org sits ` +
        `unusable until an org owner approves it). The credential monitor ` +
        `(.github/workflows/factory-ops-credential.yml, toon-meta#271) should ` +
        `have warned about this. Failing loudly — the formal review verdict ` +
        `must never silently degrade.`
    );
  }
  return { token, login };
}

/** The PR's author login (GraphQL shape, e.g. `app/toon-backlog-bot`). */
export function getPrAuthorLogin(prNumber: string): string {
  const author = gh(['pr', 'view', prNumber, '--json', 'author', '--jq', '.author.login']).trim();
  if (!author) {
    throw new Error(`Could not resolve the author of PR #${prNumber}.`);
  }
  return author;
}

/**
 * The self-approval guard: the approver must never be the PR author. GitHub
 * would reject the APPROVE/REQUEST_CHANGES with a 422 anyway — this asserts
 * the invariant BEFORE submitting, with a diagnosis instead of an API error.
 */
export function assertApproverIsNotAuthor(
  approver: FactoryOpsIdentity,
  prAuthorLogin: string
): void {
  if (normalizeLogin(approver.login) === normalizeLogin(prAuthorLogin)) {
    throw new Error(
      `Self-approval guard: FACTORY_OPS_TOKEN authenticates as ` +
        `'${approver.login}', which IS the PR author ('${prAuthorLogin}'). ` +
        `GitHub forbids a PR's author from approving it, so submitting this ` +
        `verdict could only produce a worthless COMMENTED review or a 422. ` +
        `Failing the job loudly instead. Fix: point FACTORY_OPS_TOKEN at an ` +
        `identity distinct from whatever opens agent PRs (the factory App), ` +
        `or investigate why this PR was not opened by the App.`
    );
  }
}

function factoryOpsFindingsBody(verdict: ReviewVerdict, issue: TargetIssue | null): string {
  const findings = verdict.blockingFindings
    .map(
      (f, i) =>
        `${i + 1}. \`${f.file}${f.line === null ? '' : `:${f.line}`}\` — ${f.summary}\n` +
        `   ${f.why}`
    )
    .join('\n');

  return (
    `## Reviewer verdict: BLOCKING\n\n` +
    (issue
      ? `Reviewed against issue #${issue.number} ("${issue.title}") and its acceptance criteria.\n\n`
      : `No target issue could be resolved from the PR body (no \`Closes #n\`); Standards review only.\n\n`) +
    `The sandcastle reviewer found ${verdict.blockingFindings.length} blocking finding(s):\n\n` +
    `${findings}\n\n` +
    `Applied \`${NEEDS_HUMAN_LABEL}\` — a human must resolve these findings before merge. ` +
    `(Machine verdict submitted by factory-ops; toon-protocol/toon-meta#275, #282.)`
  );
}

function factoryOpsApprovalBody(issue: TargetIssue | null): string {
  return (
    `## Reviewer verdict: CLEAN — approved by factory-ops\n\n` +
    `This approval is a **machine verdict**: it attests that the gate passed ` +
    `and the sandcastle reviewer found nothing blocking` +
    (issue
      ? ` (reviewed against issue #${issue.number}, "${issue.title}", and its acceptance criteria)`
      : ` (Standards-only review — no target issue resolved from the PR body)`) +
    `. It is not human judgement. ` +
    `See FACTORY.md, "What a factory-ops approval attests" ` +
    `(toon-protocol/toon-meta#282).`
  );
}

/**
 * Submit the formal review verdict on a PR AS FACTORY-OPS:
 *   clean    → APPROVE
 *   blocking → REQUEST_CHANGES with the findings, plus the `needs:human` label
 *
 * Resolves the approver identity and re-asserts the self-approval guard
 * itself, so no caller can reach the submission without the guard. After
 * submission the created review's state is verified from the API response —
 * anything other than the expected APPROVED/CHANGES_REQUESTED state (i.e. a
 * degraded COMMENTED review) throws.
 *
 * Label writes are pure REST via `gh api` — porcelain `gh pr edit` is broken
 * in repos with a classic Project attached (projectCards GraphQL deprecation).
 * The `needs:human` label logic lives HERE and only here (toon-meta#282 seam:
 * the pre-#282 COMMENT-review path applied it too; that path is gone).
 */
/**
 * Whether a CLEAN verdict should clear `needs:human` from this PR
 * (toon-meta#352).
 *
 * The decision itself is pure and lives in
 * `.sandcastle/needs-human-evaluator.mjs`, unit-tested by
 * `npm run test:factory` — this is only the I/O that feeds it. That split is
 * this repo's convention (see the reap/unblock/dispatch evaluators), and it is
 * the reason the ownership rule is testable at all.
 *
 * Reads the TIMELINE, not the label list: the label list says only THAT the
 * label is present, never WHO applied it, and ownership is the whole
 * distinction — a machine-applied label is stale state, a human-applied one is
 * a decision.
 *
 * Fails closed on any read error: leaving the label costs a manual edit,
 * clearing it wrongly overrules a person.
 */
function clearsNeedsHuman(prNumber: string, approverLogin: string, token: string): boolean {
  try {
    const raw = execFileSync(
      'gh',
      ['api', '--paginate', `repos/${repoNwo()}/issues/${prNumber}/timeline`],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_TOKEN: token } }
    ).toString();

    // `--paginate` concatenates one JSON array per page; normalise to one array.
    const events = raw
      .split('\n')
      .filter((line) => line.trim().startsWith('['))
      .flatMap((line) => JSON.parse(line) as unknown[]);

    return shouldClearNeedsHuman(events, approverLogin);
  } catch {
    return false;
  }
}

export function submitFactoryOpsVerdict(
  prNumber: string,
  verdict: ReviewVerdict,
  issue: TargetIssue | null
): void {
  const approver = resolveFactoryOpsIdentity();
  const prAuthor = getPrAuthorLogin(prNumber);
  assertApproverIsNotAuthor(approver, prAuthor);

  const nwo = repoNwo();
  const blocking = verdict.verdict === 'blocking';
  const event = blocking ? 'REQUEST_CHANGES' : 'APPROVE';
  const expectedState = blocking ? 'CHANGES_REQUESTED' : 'APPROVED';
  const body = blocking ? factoryOpsFindingsBody(verdict, issue) : factoryOpsApprovalBody(issue);

  console.log(
    `Submitting formal ${event} review as factory-ops ('${approver.login}') ` +
      `on PR #${prNumber} (author: '${prAuthor}').`
  );

  const response = execFileSync(
    'gh',
    ['api', `repos/${nwo}/pulls/${prNumber}/reviews`, '-f', `event=${event}`, '-f', `body=${body}`],
    { encoding: 'utf8', env: { ...process.env, GH_TOKEN: approver.token } }
  );

  // NEVER DEGRADE: verify the review GitHub actually created is in the state
  // we asked for. A COMMENTED review here would be exactly the old
  // REVIEWER_TOKEN rot, reborn — fail instead.
  const created = JSON.parse(response) as { state?: string; id?: number };
  if (created.state !== expectedState) {
    throw new Error(
      `Formal verdict DEGRADED: asked GitHub for ${event} but the created ` +
        `review (id ${created.id ?? '?'}) has state ` +
        `'${created.state ?? 'unknown'}' instead of '${expectedState}'. ` +
        `Refusing to treat this as success.`
    );
  }
  console.log(`Verified: review ${created.id} on PR #${prNumber} is ${created.state}.`);

  if (blocking) {
    // Ensure the label exists (ignore "already exists"), then add it. Both are
    // plain REST so a pre-existing label or a re-run stays idempotent.
    try {
      execFileSync(
        'gh',
        [
          'api',
          `repos/${nwo}/labels`,
          '-f',
          `name=${NEEDS_HUMAN_LABEL}`,
          '-f',
          'color=B60205',
          '-f',
          'description=Factory reviewer found blocking defects - a human must decide',
        ],
        { stdio: 'pipe', env: { ...process.env, GH_TOKEN: approver.token } }
      );
    } catch {
      // Label already exists — the normal case.
    }
    execFileSync(
      'gh',
      ['api', `repos/${nwo}/issues/${prNumber}/labels`, '-f', `labels[]=${NEEDS_HUMAN_LABEL}`],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, GH_TOKEN: approver.token },
      }
    );
    console.log(
      `Requested changes with the findings and applied '${NEEDS_HUMAN_LABEL}' on PR #${prNumber}.`
    );
  } else if (clearsNeedsHuman(prNumber, approver.login, approver.token)) {
    // The machine clears what the machine applied, and only that (toon-meta#352).
    //
    // The blocking branch above applies `needs:human` as a side effect. Nothing
    // used to remove it, so a PR that went blocking -> fixed -> clean ended
    // APPROVED *and* carrying the label — and `auto-merge.yml` refuses on it
    // ("needs-human: PR carries needs:human"). Once blocked, gated forever.
    // On 2026-08-12 that held three approved PRs at once, including #333, the
    // fix for the sibling dead-`agent:implement` wedge.
    //
    // The guard is the whole point: `needs:human` is a HUMAN control point
    // (FACTORY.md). Clearing it unconditionally on a clean verdict would let a
    // machine overrule a person who applied it deliberately — trading one bug
    // for a worse one. So we remove it ONLY when the most recent application
    // was by the approver identity itself. A human's label is never touched,
    // and a human who re-applies it after a clean verdict keeps it.
    execFileSync(
      'gh',
      [
        'api',
        '-X',
        'DELETE',
        // The colon MUST stay percent-encoded. `gh api` does not encode path
        // segments, and an unencoded `needs:human` silently no-ops (200, no
        // change) rather than erroring.
        `repos/${nwo}/issues/${prNumber}/labels/${encodeURIComponent(NEEDS_HUMAN_LABEL)}`,
      ],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, GH_TOKEN: approver.token },
      }
    );
    console.log(
      `Cleared '${NEEDS_HUMAN_LABEL}' on PR #${prNumber} — it was applied by ` +
        `${approver.login} on a previous blocking verdict, and this verdict is clean.`
    );
  }

  // Clear the trigger label now that the verdict it requested has been
  // submitted (toon-meta#355). No ownership check (unlike needs:human above):
  // agent:review is unambiguously a machine trigger, never a human control
  // point — whoever applied it, a submitted verdict means the review it asked
  // for is done. That also makes re-review symmetrical with the first review
  // (apply the label again) instead of an undocumented remove-then-re-add
  // dance the `labeled`-event trigger otherwise demands.
  //
  // The label is legitimately ABSENT on two paths: the implement runner's
  // verdict (agent-implement-issue.ts submits a verdict on a PR that was
  // never labelled agent:review) and a re-run of an already-cleared review.
  // GitHub answers a DELETE of an absent label with 404, which `gh api`
  // surfaces as a non-zero exit — so a 404 here is the expected no-op and
  // must not fail the run. Any OTHER error still throws: silently losing
  // the removal on the review-runner path would re-create the exact
  // stale-label unreadability this clear exists to fix.
  try {
    execFileSync(
      'gh',
      [
        'api',
        '-X',
        'DELETE',
        // Same encoding gotcha as NEEDS_HUMAN_LABEL above: the colon MUST stay
        // percent-encoded or this silently no-ops (200, label untouched).
        `repos/${nwo}/issues/${prNumber}/labels/${encodeURIComponent(AGENT_REVIEW_LABEL)}`,
      ],
      {
        // "pipe" (not inherit) so the catch below can read gh's stderr to
        // tell the benign 404 apart from a real failure.
        stdio: 'pipe',
        env: { ...process.env, GH_TOKEN: approver.token },
      }
    );
    console.log(
      `Cleared '${AGENT_REVIEW_LABEL}' on PR #${prNumber} — the review verdict is submitted.`
    );
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    if (!/\b404\b|Not Found/i.test(stderr)) {
      if (stderr) process.stderr.write(stderr);
      throw error;
    }
    console.log(
      `'${AGENT_REVIEW_LABEL}' was not on PR #${prNumber} — nothing to clear. ` +
        `Expected on the implement runner's verdict path and on re-runs.`
    );
  }
}
