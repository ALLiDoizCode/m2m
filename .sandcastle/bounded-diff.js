// Bounded, review-shaped diff expansion for review-prompt.md.
//
// review-prompt.md used to inline the raw `git diff {{TARGET_BRANCH}}...{{BRANCH}}`
// output straight into the reviewer's prompt via Sandcastle's `!`cmd`` shell
// expansion (see @ai-hero/sandcastle's PromptPreprocessor.ts — it runs the
// command in the sandbox and splices stdout in verbatim, with no size guard of
// its own). On issue #457 (426 files, 181k deletions) that produced a ~1.72M
// token prompt and the reviewer died before reading anything (issue #468).
//
// A deletion-shaped ticket is inherently a deletion-shaped diff, and reviewing
// a deletion does not require the deleted lines — `- }` repeated 180,000 times
// carries no signal. So this script reshapes the diff for review instead of
// dumping bytes:
//   - `git diff --stat` always, in full — the file list/magnitudes are the
//     reviewable part of a large change and are cheap regardless of diff size.
//   - Full unified-diff content for added/modified/renamed files, up to a
//     fixed token budget.
//   - Deleted files contribute their path only, never their body.
//   - Once the budget is spent, remaining files are named in an explicit
//     degradation note rather than silently dropped — the reviewer must know
//     its view is partial, not assume it saw everything.
//
// Must never exit non-zero: PromptPreprocessor treats a non-zero exit as a
// PromptError and fails the whole run before the agent starts — exactly the
// "Prompt is too long" class of failure this script exists to prevent. Any
// internal failure degrades to an inline error note in the output instead.

import { execFileSync } from 'node:child_process';

// Matches PromptPreprocessor.ts's own ~4-chars-per-token estimate, so this
// budget lines up with what the engine will actually report.
const CHARS_PER_TOKEN = 4;
const DIFF_TOKEN_BUDGET = 50_000;
const DIFF_CHAR_BUDGET = DIFF_TOKEN_BUDGET * CHARS_PER_TOKEN;

// Generous: --stat/--name-status are one line per file, but a monorepo-wide
// deletion ticket can still touch hundreds of files.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES });
}

function safeGit(args, label) {
  try {
    return { ok: true, text: git(args) };
  } catch (err) {
    return { ok: false, text: `(${label} failed: \`git ${args.join(' ')}\`: ${err.message})\n` };
  }
}

function statusLabel(code) {
  switch (code) {
    case 'A':
      return 'Added';
    case 'M':
      return 'Modified';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    default:
      return code;
  }
}

function main() {
  const [, , targetBranch, branch] = process.argv;
  if (!targetBranch || !branch) {
    console.log(
      `ERROR: bounded-diff.js requires <target-branch> <branch> arguments ` +
        `(got target=${JSON.stringify(targetBranch)}, branch=${JSON.stringify(branch)}).`
    );
    return;
  }

  const range = `${targetBranch}...${branch}`;

  const stat = safeGit(['diff', '--stat', range], 'diff --stat').text.trimEnd();

  const nameStatusResult = safeGit(['diff', '--name-status', range], 'diff --name-status');
  const entries = nameStatusResult.ok
    ? nameStatusResult.text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parts = line.split('\t');
          const status = parts[0][0];
          const path = parts[parts.length - 1];
          return { status, path };
        })
    : [];

  const deleted = entries.filter((e) => e.status === 'D');
  const contentEligible = entries.filter((e) => e.status !== 'D');

  let usedChars = stat.length;
  const included = [];
  const omitted = [];

  for (const entry of contentEligible) {
    const fileDiff = safeGit(['diff', range, '--', entry.path], `diff for ${entry.path}`).text;
    if (usedChars + fileDiff.length > DIFF_CHAR_BUDGET) {
      omitted.push(entry);
      continue;
    }
    usedChars += fileDiff.length;
    included.push({ ...entry, diff: fileDiff.trimEnd() });
  }

  const sections = [];

  sections.push(`## Diff stat\n\n\`\`\`\n${stat}\n\`\`\``);

  if (!nameStatusResult.ok) {
    sections.push(`## NOTE: unable to list changed files\n\n${nameStatusResult.text.trimEnd()}`);
  }

  if (included.length > 0) {
    sections.push(
      '## Added/modified/renamed file contents\n\n' +
        included
          .map((e) => `### ${statusLabel(e.status)}: ${e.path}\n\n\`\`\`diff\n${e.diff}\n\`\`\``)
          .join('\n\n')
    );
  }

  if (deleted.length > 0) {
    sections.push(
      '## Deleted files (paths only — content omitted; a deletion carries no reviewable body)\n\n' +
        deleted.map((e) => `- ${e.path}`).join('\n')
    );
  }

  if (omitted.length > 0) {
    sections.push(
      `## NOTE: diff content truncated at a ~${DIFF_TOKEN_BUDGET}-token budget\n\n` +
        `The following ${omitted.length} added/modified/renamed file(s) exceeded the budget ` +
        'and their content is NOT included above. Judge them only from the diff stat — ' +
        'do not assume they were reviewed:\n\n' +
        omitted.map((e) => `- ${statusLabel(e.status)}: ${e.path}`).join('\n')
    );
  }

  console.log(sections.join('\n\n'));
}

main();
