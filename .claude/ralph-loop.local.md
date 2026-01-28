---
active: true
iteration: 4
max_iterations: 5
completion_promise: "EPIC_17_COMPLETE"
started_at: "2026-01-28T19:10:03Z"
---

Execute BMAD cycle for Epic 17 (nip 90 dvm compatibility).

## Phase 0: Branch Setup
git checkout main && git fetch origin && git pull origin main
git checkout -b epic-17 || git checkout epic-17

## Cycle (repeat for each story)

### Phase 1: Story Creation (SM)
Adopt SM from .bmad-core/agents/sm.md. Execute .bmad-core/tasks/create-next-story.md for Epic 17 using docs/prd/epic-17-nip-90-dvm-compatibility.md. If no more stories → Phase 7.

### Phase 2: Validation (PO)
Adopt PO from .bmad-core/agents/po.md. Execute .bmad-core/tasks/validate-next-story.md. NO-GO → fix and retry. GO → proceed.

### Phase 3: Implementation (Dev)
Adopt Dev from .bmad-core/agents/dev.md. Load devLoadAlwaysFiles from core-config. Implement tasks with TDD. Run npm test after changes. Set Status: Review.

### Phase 4: QA Review (QA)
Adopt QA from .bmad-core/agents/qa.md. Execute .bmad-core/tasks/review-story.md. Create gate in docs/qa/gates/. PASS → Phase 6. CONCERNS/FAIL → Phase 5.

### Phase 5: Apply Fixes (Dev)
Execute .bmad-core/tasks/apply-qa-fixes.md. Fix issues by priority. Return to Phase 4.

### Phase 6: Commit
git add files && git commit. Set Status: Done. If more stories → Phase 1. Else → Phase 7.

### Phase 7: Push & Create PR
git push -u origin epic-17
gh pr create --title 'Epic 17: nip 90 dvm compatibility' --body 'Implements Epic 17. All stories completed and QA approved.'

### Phase 8: Fix CI
gh pr checks (or gh run list --branch epic-17 --limit 5)
If running → wait and check again.
If failed → gh run view --log-failed, analyze, fix locally, commit, push, repeat.
If passed → Phase 9.

### Phase 9: Merge PR
gh pr merge --squash --delete-branch
git checkout main && git pull origin main
Complete.

## Completion
<promise>EPIC_17_COMPLETE</promise> when: all stories done, PR merged to main, local main synced.

## If Blocked
After 5 iterations stuck → document in docs/stories/17-blocker.md → <promise>EPIC_17_BLOCKED</promise>
