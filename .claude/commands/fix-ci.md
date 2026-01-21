# Fix CI Failures

Check the GitHub Actions status for the current branch and fix any failing tests or checks.

## Steps

1. Run `gh run list --branch $(git branch --show-current) --limit 5` to see recent workflow runs
2. Run `gh run view --log-failed` to get the failure logs from the most recent failed run
3. Analyze the failures and identify the root cause
4. Make the necessary code fixes
5. Run the relevant tests locally to verify the fix works
6. Commit the changes with a descriptive message
7. Push the fixes to GitHub
8. Summarize what was broken and what you fixed