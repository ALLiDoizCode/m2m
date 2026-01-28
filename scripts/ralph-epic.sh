#!/bin/bash
# BMAD Ralph Loop Launcher
# Usage: ./scripts/ralph-epic.sh <epic_number> [max_iterations]
#
# Prompt template: .claude/ralph-prompts/epic-cycle.md

set -e

EPIC_NUMBER="${1:-17}"
MAX_ITERATIONS="${2:-100}"

# Find the actual PRD file
PRD_FILE=$(ls docs/prd/epic-${EPIC_NUMBER}-*.md 2>/dev/null | head -1)
if [ -z "$PRD_FILE" ]; then
    echo "Error: No PRD file found for Epic ${EPIC_NUMBER} in docs/prd/"
    echo "Expected pattern: docs/prd/epic-${EPIC_NUMBER}-*.md"
    exit 1
fi

# Extract epic title from PRD filename (remove epic-N- prefix and .md suffix, convert to title case)
EPIC_TITLE=$(basename "$PRD_FILE" .md | sed "s/epic-${EPIC_NUMBER}-//" | tr '-' ' ')

echo "==================================="
echo "BMAD Ralph Loop - Epic ${EPIC_NUMBER}"
echo "==================================="
echo "PRD File: ${PRD_FILE}"
echo "Epic Title: ${EPIC_TITLE}"
echo "Max Iterations: ${MAX_ITERATIONS}"
echo "Branch: epic-${EPIC_NUMBER}"
echo "==================================="
echo ""
echo "Copy and paste this command into Claude Code:"
echo ""

# Output the command to copy
cat << COMMAND
/ralph-loop "Execute BMAD cycle for Epic ${EPIC_NUMBER} (${EPIC_TITLE}).

## Phase 0: Branch Setup
git checkout main && git fetch origin && git pull origin main
git checkout -b epic-${EPIC_NUMBER} || git checkout epic-${EPIC_NUMBER}

## Cycle (repeat for each story)

### Phase 1: Story Creation (SM)
Adopt SM from .bmad-core/agents/sm.md. Execute .bmad-core/tasks/create-next-story.md for Epic ${EPIC_NUMBER} using ${PRD_FILE}. If no more stories → Phase 7.

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
git push -u origin epic-${EPIC_NUMBER}
gh pr create --title 'Epic ${EPIC_NUMBER}: ${EPIC_TITLE}' --body 'Implements Epic ${EPIC_NUMBER}. All stories completed and QA approved.'

### Phase 8: Fix CI
gh pr checks (or gh run list --branch epic-${EPIC_NUMBER} --limit 5)
If running → wait and check again.
If failed → gh run view --log-failed, analyze, fix locally, commit, push, repeat.
If passed → Phase 9.

### Phase 9: Merge PR
gh pr merge --squash --delete-branch
git checkout main && git pull origin main
Complete.

## Completion
<promise>EPIC_${EPIC_NUMBER}_COMPLETE</promise> when: all stories done, PR merged to main, local main synced.

## If Blocked
After 5 iterations stuck → document in docs/stories/${EPIC_NUMBER}-blocker.md → <promise>EPIC_${EPIC_NUMBER}_BLOCKED</promise>" --max-iterations ${MAX_ITERATIONS} --completion-promise "EPIC_${EPIC_NUMBER}_COMPLETE"
COMMAND

echo ""
echo "==================================="
