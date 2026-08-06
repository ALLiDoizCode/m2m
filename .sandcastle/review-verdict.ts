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

/**
 * Post a blocking verdict's findings as a PR review (event COMMENT) and apply
 * the `needs:human` label. Pure REST via `gh api` — porcelain `gh pr edit` is
 * broken in repos with a classic Project attached (projectCards GraphQL
 * deprecation), so label writes must not go through it.
 */
export function postBlockingVerdict(
  prNumber: string,
  verdict: ReviewVerdict,
  issue: TargetIssue | null
): void {
  const nwo = repoNwo();

  const findings = verdict.blockingFindings
    .map(
      (f, i) =>
        `${i + 1}. \`${f.file}${f.line === null ? '' : `:${f.line}`}\` — ${f.summary}\n` +
        `   ${f.why}`
    )
    .join('\n');

  const body =
    `## Reviewer verdict: BLOCKING\n\n` +
    (issue
      ? `Reviewed against issue #${issue.number} ("${issue.title}") and its acceptance criteria.\n\n`
      : `No target issue could be resolved from the PR body (no \`Closes #n\`); Standards review only.\n\n`) +
    `The sandcastle reviewer found ${verdict.blockingFindings.length} blocking finding(s):\n\n` +
    `${findings}\n\n` +
    `Applied \`${NEEDS_HUMAN_LABEL}\` — a human must resolve these findings before merge. ` +
    `(Structured reviewer verdict, toon-protocol/toon-meta#275.)`;

  execFileSync(
    'gh',
    ['api', `repos/${nwo}/pulls/${prNumber}/reviews`, '-f', 'event=COMMENT', '-f', `body=${body}`],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );

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
      { stdio: 'pipe' }
    );
  } catch {
    // Label already exists — the normal case.
  }
  execFileSync(
    'gh',
    ['api', `repos/${nwo}/issues/${prNumber}/labels`, '-f', `labels[]=${NEEDS_HUMAN_LABEL}`],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );

  console.log(
    `Posted blocking findings as a PR review and applied '${NEEDS_HUMAN_LABEL}' on PR #${prNumber}.`
  );
}
