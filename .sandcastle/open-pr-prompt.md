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

2. Wire `git push` authentication so the push below is NOT unauthenticated.
   `gh` is authenticated from `GH_TOKEN`, but a bare `git push` uses git's own
   credential system. Install `gh` as git's credential helper (idempotent; the
   onSandboxReady hook already did this, but re-run it here so this step is
   self-contained):

   `gh auth setup-git`

3. Push the branch to origin, then CONFIRM the remote ref actually exists — a
   push can fail without an obvious error:

   `git push -u origin {{BRANCH}}`
   `git ls-remote --heads origin {{BRANCH}}`

   If `git ls-remote` prints NO line for `{{BRANCH}}`, the push FAILED. Do
   **not** output `<promise>COMPLETE</promise>`. Instead print the push error
   and stop — the runner will detect the missing PR and fail the job.

4. Check whether a PR for this branch already exists:

   `gh pr list --head {{BRANCH}} --state open --json number --jq '.[].number'`
   - If one already exists, leave it as-is (do not open a duplicate) and go to
     step 6 to verify.
   - Otherwise open a new PR (step 5).

5. Open the PR:

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

6. VERIFY a PR now exists before claiming success:

   `gh pr list --head {{BRANCH}} --state open --json number,url`

   If this prints an empty list (`[]`), the push or PR creation did NOT land.
   Do **not** output `<promise>COMPLETE</promise>` — print what went wrong and
   stop.

# RULES

- Never run `git merge`, `gh pr merge`, or `gh issue close`.
- Do not modify code here — implementation and review already happened on this
  branch. This step only publishes the branch and opens the PR.
- Only output `<promise>COMPLETE</promise>` once you have CONFIRMED (step 3 +
  step 6) that the branch is pushed AND an open PR exists. A failed push or a
  missing PR is a failure, not a COMPLETE.

Once the branch is pushed and an open PR is confirmed to exist, output
`<promise>COMPLETE</promise>`.
