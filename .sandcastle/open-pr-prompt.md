# TASK

Push branch `{{BRANCH}}` and open a pull request against `main` for issue #{{TASK_ID}} ({{ISSUE_TITLE}}). **Do NOT merge anything. Do NOT close the
issue.** A human reviews and merges the PR.

# STEPS

1. Confirm you are on branch `{{BRANCH}}` and that it has commits ahead of
   `main`:

   !`git rev-parse --abbrev-ref HEAD`
   !`git log main..{{BRANCH}} --oneline`

   If there are no commits ahead of `main`, output `<promise>COMPLETE</promise>`
   and stop — there is nothing to open a PR for.

2. Push the branch to origin:

   `git push -u origin {{BRANCH}}`

3. Check whether a PR for this branch already exists:

   `gh pr list --head {{BRANCH}} --state open --json number --jq '.[].number'`
   - If one already exists, leave it as-is (do not open a duplicate) and stop.
   - Otherwise open a new PR (step 4).

4. Open the PR:

   ```
   gh pr create \
     --base main \
     --head {{BRANCH}} \
     --title "{{ISSUE_TITLE}}" \
     --body "<body below>"
   ```

   PR body must:
   - Start with a one-line summary of what changed.
   - Reference the issue with `Part of #{{TASK_ID}}` — **NOT** `Closes #` or
     `Fixes #`. The issue only closes once a human has reviewed and merged this
     PR; do not auto-close it.
   - Note that this PR was produced by the sandcastle `agent:implement` runner
     and is awaiting human review.
   - End with the line:
     `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

# RULES

- Never run `git merge`, `gh pr merge`, or `gh issue close`.
- Do not modify code here — implementation and review already happened on this
  branch. This step only publishes the branch and opens the PR.

Once the PR is open (or already existed), output `<promise>COMPLETE</promise>`.
