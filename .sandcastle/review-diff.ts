// Bounded review-diff renderer — the shell expansion behind `## Branch diff` in
// .sandcastle/review-prompt.md (used by BOTH the parallel loop in ./main.ts and
// the standalone runner in ./agent-review-pr.ts, which share that prompt file).
//
// WHY THIS EXISTS (connector#468)
// ------------------------------
// review-prompt.md used to inline the raw diff:
//
//     !`git diff {{TARGET_BRANCH}}...{{BRANCH}}`
//
// with no size guard. On #457 (`426 files changed, 2463 insertions(+),
// 181367 deletions(-)` — the correct shape for a "delete the embedded node"
// ticket) the engine expanded that to ~1,724,718 tokens and the reviewer died
// with `Prompt is too long` before reading a single line. That failure lands
// AFTER the implementer has already run, so it burned three runs.
//
// The fix is not smaller tickets — it is not dumping bytes. Reviewing a deletion
// does not require the deleted lines: `- }` repeated 180,000 times carries no
// signal. What a reviewer needs is WHICH files went, that nothing surviving
// references them, and the content of the INSERTED lines.
//
// WHAT IT EMITS
//   * `git diff --stat` — always, for every change size. The file list and
//     magnitudes are the reviewable part of a large change.
//   * If the whole diff fits the budget: the diff verbatim, byte for byte. The
//     common case is deliberately untouched.
//   * Otherwise a BOUNDED view: deleted files as paths only, and the full diff
//     of added/changed files in ascending size order until the budget is spent,
//     followed by an explicit list of what was left out.
//
// The output NEVER exceeds the budget, so the reviewer can never be killed by
// `Prompt is too long`. When anything is omitted the output says so loudly and
// tells the reviewer it can run `git diff` itself — it has a shell and the whole
// repository, so a bounded prompt costs it reach, not access.
//
// Usage (from the repository root):
//   npx tsx .sandcastle/review-diff.ts <target-branch> <branch>
//
// Budget override (tokens): SANDCASTLE_REVIEW_DIFF_BUDGET_TOKENS=90000
//
// CJS NOTE: connector's root package.json has no `"type": "module"`, so tsx may
// transform `.sandcastle` entrypoints to CommonJS, where top-level `await` is a
// compile error. Everything here is synchronous — do not introduce top-level
// await. See ./agent-review-pr.ts for the same warning.

import { execFileSync } from 'node:child_process';

/**
 * Token budget for the whole `## Branch diff` section.
 *
 * The reviewer runs on a 200k-context model and still has to read files, run the
 * gate and write commits, so the diff gets a minority share of the window.
 */
const DEFAULT_BUDGET_TOKENS = 60_000;

/** `git diff` output for a large repo can be tens of MB — do not let it truncate. */
const GIT_MAX_BUFFER_BYTES = 512 * 1024 * 1024;

/**
 * The engine estimates prompt cost as `Math.ceil(text.length / 4)` (see
 * PromptPreprocessor in @ai-hero/sandcastle). Budget against the SAME estimator
 * the engine reports, so the numbers in the run log and the numbers here agree.
 */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const git = (args: string[]): string =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });

/** One added/modified/renamed file's slice of the diff, split off at `diff --git`. */
interface FileDiff {
  path: string;
  body: string;
  tokens: number;
}

/**
 * Split a multi-file diff into per-file chunks.
 *
 * Every file's section starts at column 0 with `diff --git a/<old> b/<new>`, and
 * no line inside a hunk can start that way (context lines carry a leading space,
 * changed lines a `+`/`-`), so the header is an unambiguous boundary.
 */
const splitByFile = (diff: string): FileDiff[] => {
  if (diff.trim() === '') return [];

  const chunks: FileDiff[] = [];
  const lines = diff.split('\n');
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const body = current.join('\n').replace(/\s+$/, '');
    chunks.push({ path: pathFromHeader(current[0]), body, tokens: estimateTokens(body) });
    current = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) flush();
    current.push(line);
  }
  flush();

  return chunks;
};

/**
 * Recover the file path from a `diff --git a/<old> b/<new>` header.
 *
 * Paths containing spaces make the header ambiguous to split, so this is a
 * best-effort label only — it is used for the "omitted" list and for sorting,
 * never to drive a git command.
 */
const pathFromHeader = (header: string): string => {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  if (!match) return header.replace(/^diff --git /, '').trim();
  const [, oldPath, newPath] = match;
  return oldPath === newPath ? newPath : `${oldPath} -> ${newPath}`;
};

/** Split NUL-terminated `git ... -z` output into entries. */
const splitNulTerminated = (out: string): string[] => out.split('\0').filter((s) => s !== '');

/**
 * Total changed lines, parsed out of `git diff --stat`'s trailing summary.
 *
 * Used as a cheap lower bound: every diff line costs at least one token, so a
 * change with more lines than the budget can never fit and its full text is not
 * worth materialising. Returns `null` when the summary cannot be parsed, in
 * which case the caller falls back to measuring the real diff.
 */
const changedLinesFromStat = (stat: string): number | null => {
  const summary = stat.trimEnd().split('\n').at(-1);
  if (!summary) return null;
  const insertions = /(\d+) insertion/.exec(summary);
  const deletions = /(\d+) deletion/.exec(summary);
  if (!insertions && !deletions) return null;
  return Number(insertions?.[1] ?? 0) + Number(deletions?.[1] ?? 0);
};

const fence = (body: string): string => '```\n' + body + '\n```';

/**
 * Keep a `git diff --stat` body under `maxTokens`, dropping per-file lines from
 * the end but always preserving the trailing `N files changed, ...` summary —
 * that one line is what tells the reviewer how much it is not seeing.
 */
const truncateStat = (stat: string, maxTokens: number, range: string): string => {
  if (estimateTokens(stat) <= maxTokens) return stat;

  const lines = stat.split('\n');
  const summary = lines.at(-1) ?? '';
  const fileLines = lines.slice(0, -1);

  const kept: string[] = [];
  let used = estimateTokens(summary);
  for (const line of fileLines) {
    const cost = estimateTokens(line) + 1;
    // Leave room for the "... and N more" line the loop is about to need.
    if (used + cost > maxTokens - 40) break;
    kept.push(line);
    used += cost;
  }

  const dropped = fileLines.length - kept.length;
  return [
    ...kept,
    ` ... and ${dropped} more changed file(s) — this file list was TRUNCATED to fit the`,
    ` token budget. Run \`git diff --stat ${range}\` yourself for the complete list.`,
    summary,
  ].join('\n');
};

const bulletList = (items: string[]): string => items.map((item) => `- \`${item}\``).join('\n');

/**
 * Render a path list as bullets, dropping entries past `maxTokens` and saying
 * how many were dropped. A list is only useful if it is honest about being
 * short, so the tail is replaced rather than silently cut.
 */
const boundedBulletList = (items: string[], maxTokens: number): string => {
  const full = bulletList(items);
  if (estimateTokens(full) <= maxTokens) return full;

  const kept: string[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(`- \`${item}\`\n`);
    // Leave room for the "... and N more" line the loop is about to need.
    if (used + cost > maxTokens - 30) break;
    kept.push(item);
    used += cost;
  }

  return `${bulletList(kept)}\n- ... and ${items.length - kept.length} more, not listed (this list was TRUNCATED to fit the token budget).`;
};

interface RenderOptions {
  targetBranch: string;
  branch: string;
  budgetTokens: number;
}

const render = ({ targetBranch, branch, budgetTokens }: RenderOptions): string => {
  const range = `${targetBranch}...${branch}`;
  const stat = git(['diff', '--stat', range]).trimEnd();

  if (stat === '') {
    return `No changes between \`${targetBranch}\` and \`${branch}\` (\`git diff ${range}\` is empty).`;
  }

  // The stat is the single most valuable thing in a large review, but it is not
  // free: one line per file means a several-thousand-file change could spend the
  // whole budget on the summary alone and crowd out the notice explaining that
  // the view is partial. Cap it at half the budget.
  const statSection = `### Change summary — \`git diff --stat ${range}\`\n\n${fence(
    truncateStat(stat, Math.floor(budgetTokens / 2), range)
  )}`;
  const remainingAfterStat = budgetTokens - estimateTokens(statSection);

  // Cheap pre-check: skip materialising a diff that provably cannot fit.
  const changedLines = changedLinesFromStat(stat);
  const worthMeasuringInFull = changedLines === null || changedLines <= remainingAfterStat;

  if (worthMeasuringInFull) {
    const fullDiff = git(['diff', range]).trimEnd();
    if (estimateTokens(fullDiff) <= remainingAfterStat) {
      // COMMON CASE — the diff is reproduced byte for byte, exactly as the
      // unbounded expansion used to emit it. Only the stat header is new.
      return `${statSection}\n\n### Full diff — \`git diff ${range}\`\n\n${fullDiff}`;
    }
  }

  return renderBounded({ range, statSection, budgetTokens, remainingAfterStat });
};

interface BoundedOptions {
  range: string;
  statSection: string;
  budgetTokens: number;
  remainingAfterStat: number;
}

const renderBounded = ({
  range,
  statSection,
  budgetTokens,
  remainingAfterStat,
}: BoundedOptions): string => {
  // Deleted files contribute their PATHS, never their bodies — the whole point.
  const deletedPaths = splitNulTerminated(
    git(['diff', '--name-only', '--diff-filter=D', '-z', range])
  ).sort();

  // Lowercase `d` in --diff-filter EXCLUDES deletions, so this is the inserted
  // and modified content only: the part of a deletion-shaped change that a
  // reviewer actually has to read.
  const survivingDiff = git(['diff', '--diff-filter=d', range]);
  const files = splitByFile(survivingDiff);

  // Reserve room for the notice and the two path lists BEFORE packing content.
  // They must never be the thing that gets dropped: a partial view the reviewer
  // cannot tell is partial is worse than no view at all. Each list gets a
  // capped share and is truncated (loudly) inside it, so no single one of them
  // can starve the others or the diff content.
  const NOTICE_RESERVE_TOKENS = 600;
  const deletedListTokens = Math.floor(budgetTokens * 0.25);
  const omittedListTokens = Math.floor(budgetTokens * 0.15);
  const deletedList = boundedBulletList(deletedPaths, deletedListTokens);
  let remaining =
    remainingAfterStat - estimateTokens(deletedList) - omittedListTokens - NOTICE_RESERVE_TOKENS;

  // Smallest first: fit as many complete files as the budget allows rather than
  // letting one generated blob crowd out a dozen hand-written ones.
  const included: FileDiff[] = [];
  const omitted: FileDiff[] = [];
  for (const file of [...files].sort((a, b) => a.tokens - b.tokens)) {
    if (file.tokens <= remaining) {
      included.push(file);
      remaining -= file.tokens;
    } else {
      omitted.push(file);
    }
  }

  // The notice comes FIRST, ahead of even the stat: if anything downstream is
  // cut, the reader must still have been told the view is partial.
  const sections = [
    [
      '### BOUNDED VIEW — this diff did not fit and was reduced',
      '',
      `This change is too large to inline in full (budget: ${budgetTokens.toLocaleString()} tokens).`,
      'What you are reading below is DELIBERATELY PARTIAL:',
      '',
      `- **${deletedPaths.length} deleted file(s)**: paths only, bodies omitted. Removed lines carry no review signal — what matters is that the right files went and that nothing surviving still references them.`,
      `- **${included.length} of ${files.length} added/changed file(s)**: full diff included below.`,
      `- **${omitted.length} added/changed file(s)**: omitted entirely, listed by path below.`,
      '',
      '**Do not approve content you have not seen.** You have a shell and the whole',
      `repository — read anything omitted with \`git diff ${range} -- <path>\`, and check`,
      'for dangling references to deleted paths with `grep`. If you cannot verify a',
      'section, say so in your review instead of passing it silently.',
    ].join('\n'),
    statSection,
  ];

  if (deletedPaths.length > 0) {
    sections.push(
      `### Deleted files — ${deletedPaths.length} (paths only, bodies omitted)\n\n${deletedList}`
    );
  }

  if (omitted.length > 0) {
    sections.push(
      [
        `### Added/changed files with their content OMITTED — ${omitted.length} (over budget)`,
        '',
        'These files changed and you have NOT been shown how. Read them yourself if',
        'they matter to the change:',
        '',
        boundedBulletList(
          omitted.map((f) => `${f.path}  (~${f.tokens.toLocaleString()} tokens)`),
          omittedListTokens
        ),
      ].join('\n')
    );
  }

  if (included.length > 0) {
    // Restore the diff's natural file order for reading; the size sort was only
    // ever a packing strategy.
    const order = new Map(files.map((f, i) => [f.path, i]));
    const body = included
      .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0))
      .map((f) => f.body)
      .join('\n');
    sections.push(`### Added/changed files — full diff (${included.length} file(s))\n\n${body}`);
  } else if (files.length > 0) {
    sections.push(
      '### Added/changed files — full diff\n\nNone included: every added/changed file is individually larger than the remaining budget.'
    );
  }

  return sections.join('\n\n');
};

const main = () => {
  const [targetBranch, branch] = process.argv.slice(2);
  if (!targetBranch || !branch) {
    throw new Error(
      'Usage: npx tsx .sandcastle/review-diff.ts <target-branch> <branch> ' +
        `(got: ${JSON.stringify(process.argv.slice(2))})`
    );
  }

  const override = process.env.SANDCASTLE_REVIEW_DIFF_BUDGET_TOKENS?.trim();
  if (override && !/^\d+$/.test(override)) {
    throw new Error(
      `SANDCASTLE_REVIEW_DIFF_BUDGET_TOKENS must be a positive integer (got: ${JSON.stringify(override)}).`
    );
  }
  const budgetTokens = override ? Number(override) : DEFAULT_BUDGET_TOKENS;

  // Clamp the trailing newline too, so the emitted bytes are what was budgeted.
  process.stdout.write(
    clampToBudget(render({ targetBranch, branch, budgetTokens }) + '\n', budgetTokens)
  );
};

/**
 * Last-resort guarantee that the budget holds no matter what the packing above
 * did. Nothing should reach this — but "the reviewer must never die with
 * `Prompt is too long`" is an invariant, not a best effort, so it is enforced
 * unconditionally at the boundary rather than trusted to the arithmetic.
 *
 * The tail is what gets cut, and the tail is the per-file diff content — so the
 * stat, the bounded-view notice and the omitted-path lists always survive.
 */
const clampToBudget = (output: string, budgetTokens: number): string => {
  if (estimateTokens(output) <= budgetTokens) return output;

  const notice =
    '\n\n### HARD-TRUNCATED\n\nThe output above hit the ' +
    `${budgetTokens.toLocaleString()}-token ceiling and was cut mid-diff. ` +
    'Everything past this point is missing entirely. Read the rest with `git diff` yourself.\n';
  const keepChars = budgetTokens * 4 - notice.length;
  return output.slice(0, Math.max(0, keepChars)) + notice;
};

main();
