# TASK

The reviewer just committed refinements on branch `{{BRANCH}}`. Push them to
origin so the open pull request picks them up. **Do NOT merge, close, or open a
new PR.**

# STEPS

1. Confirm the branch has commits to push:

   !`git log origin/{{BRANCH}}..{{BRANCH}} --oneline`

   If there is nothing ahead of `origin/{{BRANCH}}`, output
   `<promise>COMPLETE</promise>` and stop.

2. Push:

   `git push origin {{BRANCH}}`

# RULES

- Never run `git merge`, `gh pr merge`, or `gh issue close`.
- Do not open a new PR — the existing PR updates automatically from the push.

Once pushed, output `<promise>COMPLETE</promise>`.
