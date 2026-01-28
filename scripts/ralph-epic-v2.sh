#!/bin/bash
# BMAD Ralph Loop V2 - Context-Clearing Per-Phase Workflow
# Usage: ./scripts/ralph-epic-v2.sh <epic_number> [max_iterations]
#
# This version clears Claude context between phases and commits/pushes after each phase

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

# Extract epic title from PRD filename
EPIC_TITLE=$(basename "$PRD_FILE" .md | sed "s/epic-${EPIC_NUMBER}-//" | tr '-' ' ')

echo "==================================="
echo "BMAD Ralph Loop V2 - Epic ${EPIC_NUMBER}"
echo "==================================="
echo "PRD File: ${PRD_FILE}"
echo "Epic Title: ${EPIC_TITLE}"
echo "Max Iterations: ${MAX_ITERATIONS}"
echo "Branch: epic-${EPIC_NUMBER}"
echo "Context: CLEARED BETWEEN PHASES"
echo "==================================="
echo ""
echo "Copy and paste this command into Claude Code:"
echo ""

# Output the command to copy
cat << 'COMMAND'
/ralph-loop "BMAD Epic Development Cycle with Context Clearing

## CRITICAL WORKFLOW RULES

1. **Check Git History First**: Always run `git log --oneline -10` to determine current phase
2. **Complete One Phase**: Execute the current phase completely
3. **Commit Phase Work**: Commit with phase-specific message
4. **Push & Handle Hooks**: Push to remote, fix any pre-push hook failures
5. **Clear Context**: Run `/clear` after successful push
6. **Loop Restarts**: Stop hook will re-feed this prompt, git log determines next phase

## Phase Detection from Git Log

Use `git log --oneline -10` to check most recent commits:

- **No commits on epic branch** → Start Phase 0 (Branch Setup)
- **Last commit contains 'setup branch'** → Start Phase 1 (Story Creation)
- **Last commit contains 'create story'** → Start Phase 2 (Validation)
- **Last commit contains 'approve story'** → Start Phase 3 (Implementation)
- **Last commit contains 'implement story'** → Start Phase 4 (QA Review)
- **Last commit contains 'qa review'** → Check gate status:
  - PASS → Phase 6 (Commit Story)
  - FAIL/CONCERNS → Phase 5 (Apply Fixes)
- **Last commit contains 'apply fixes'** → Return to Phase 4 (Re-review)
- **Last commit contains 'complete story'** → Check for more stories:
  - More stories → Phase 1 (Next Story)
  - No more stories → Phase 7 (Push & PR)
- **Last commit contains 'create PR'** → Phase 8 (Fix CI)
- **PR merged** → Complete, output `<promise>EPIC_COMPLETE</promise>`

## Phase 0: Branch Setup

**Check**: `git branch --show-current` - if not on epic-17, execute this phase

1. Sync with main:
   ```bash
   git checkout main && git fetch origin && git pull origin main
   ```

2. Create/checkout epic branch:
   ```bash
   git checkout -b epic-17 || git checkout epic-17
   ```

3. Commit branch setup:
   ```bash
   git commit --allow-empty -m "chore(epic-17): setup branch for nip 90 dvm compatibility"
   ```

4. Push to remote:
   ```bash
   git push -u origin epic-17
   ```

5. **If pre-push hook fails**: Fix the issue, commit fix, push again

6. **Run `/clear`** to reset context

## Phase 1: Story Creation

**Check**: Look for draft story that needs creation

1. Adopt SM persona from `.bmad-core/agents/sm.md`
2. Check `docs/stories/` for next story number
3. Execute `.bmad-core/tasks/create-next-story.md`
4. Create story file `docs/stories/17.{N}.story.md` with Status: Draft
5. Commit:
   ```bash
   git add docs/stories/
   git commit -m "docs(epic-17): create story 17.{N} - {title}"
   ```

6. Push:
   ```bash
   git push
   ```

7. **If pre-push hook fails**: Run the failing command, fix issues, commit fixes, push again

8. **If no more stories exist**: Skip to Phase 7

9. **Run `/clear`** to reset context

## Phase 2: Story Validation

**Check**: Draft story exists, needs validation

1. Adopt PO persona from `.bmad-core/agents/po.md`
2. Execute `.bmad-core/tasks/validate-next-story.md` on draft story
3. Review validation report:
   - **GO**: Update story Status to "Approved"
   - **NO-GO**: Fix issues, update story, return to Phase 1
4. Commit:
   ```bash
   git add docs/stories/
   git commit -m "docs(epic-17): approve story 17.{N} after validation"
   ```

5. Push:
   ```bash
   git push
   ```

6. **If pre-push hook fails**: Fix, commit, push again

7. **Run `/clear`** to reset context

## Phase 3: Implementation

**Check**: Approved story exists, needs implementation

1. Adopt Dev persona from `.bmad-core/agents/dev.md`
2. Load `devLoadAlwaysFiles` from `.bmad-core/core-config.yaml`
3. Read approved story file
4. Implement all tasks/subtasks with TDD
5. Run tests after each change: `npm test`
6. Update story sections (Dev Agent Record, File List, Change Log)
7. Set story Status to "Review"
8. Final validation:
   ```bash
   npm run lint && npm test && npm run build
   ```

9. Commit:
   ```bash
   git add .
   git commit -m "feat(epic-17): implement story 17.{N} - {title}

   - All acceptance criteria met
   - All tests passing
   - Ready for QA review

   Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
   ```

10. Push:
    ```bash
    git push
    ```

11. **If pre-push hook fails**: This is CRITICAL - the hook is protecting code quality
    - Read the error message carefully
    - Run the failing command manually (e.g., `npm test`, `npm run lint`)
    - Fix ALL issues
    - Stage fixes: `git add .`
    - Commit fixes: `git commit -m "fix(epic-17): resolve pre-push hook failures for story 17.{N}"`
    - Push again: `git push`
    - Repeat until push succeeds

12. **Run `/clear`** to reset context

## Phase 4: QA Review

**Check**: Story in "Review" status, needs QA

1. Adopt QA persona from `.bmad-core/agents/qa.md`
2. Execute `.bmad-core/tasks/review-story.md`
3. Create gate file in `docs/qa/gates/17.{N}-{title}.yml`
4. Update QA Results section in story
5. Determine gate status: PASS/CONCERNS/FAIL
6. Commit:
   ```bash
   git add docs/stories/ docs/qa/gates/
   git commit -m "docs(epic-17): qa review story 17.{N} - status: {GATE_STATUS}"
   ```

7. Push:
   ```bash
   git push
   ```

8. **If pre-push hook fails**: Fix, commit, push again

9. **Run `/clear`** to reset context

## Phase 5: Apply QA Fixes

**Check**: QA gate FAIL or CONCERNS, needs fixes

1. Adopt Dev persona from `.bmad-core/agents/dev.md`
2. Execute `.bmad-core/tasks/apply-qa-fixes.md`
3. Address issues by priority (high → medium → low)
4. Run validation: `npm run lint && npm test`
5. Update story
6. Commit:
   ```bash
   git add .
   git commit -m "fix(epic-17): apply qa fixes for story 17.{N}

   - Addressed all critical issues
   - All tests passing

   Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
   ```

7. Push:
   ```bash
   git push
   ```

8. **If pre-push hook fails**: Fix thoroughly, commit, push again

9. **Run `/clear`** to reset context

10. **Next**: Return to Phase 4 for re-review

## Phase 6: Complete Story

**Check**: QA gate PASS, story ready to mark Done

1. Update story Status to "Done"
2. Commit:
   ```bash
   git add docs/stories/
   git commit -m "docs(epic-17): complete story 17.{N} - {title}

   - All acceptance criteria implemented
   - QA gate: PASS
   - All tests passing"
   ```

3. Push:
   ```bash
   git push
   ```

4. **If pre-push hook fails**: Fix, commit, push again

5. Check for more stories:
   - More stories exist → Next phase is Phase 1 (create next story)
   - No more stories → Next phase is Phase 7 (create PR)

6. **Run `/clear`** to reset context

## Phase 7: Create Pull Request

**Check**: All stories Done, no PR exists yet

1. Verify all stories complete: `ls docs/stories/17.*.story.md` and check Status: Done
2. Push final changes:
   ```bash
   git push origin epic-17
   ```

3. Create PR:
   ```bash
   gh pr create --title "Epic 17: nip 90 dvm compatibility" --body "## Summary
   - Implements Epic 17: NIP-90 DVM Compatibility
   - All stories completed and QA approved
   - See docs/stories/17.*.story.md for details

   ## Stories Completed
   [List stories here]

   ## Test Plan
   - All unit tests passing
   - All integration tests passing
   - QA gates passed for all stories

   🤖 Generated with Claude Code"
   ```

4. Commit PR creation marker:
   ```bash
   git commit --allow-empty -m "chore(epic-17): create PR for epic"
   ```

5. Push:
   ```bash
   git push
   ```

6. **Run `/clear`** to reset context

## Phase 8: Fix CI Issues

**Check**: PR exists, needs CI monitoring

1. Check CI status:
   ```bash
   gh pr checks
   ```

2. **If running**: Wait 30 seconds, check again

3. **If failed**:
   - Get logs: `gh run view --log-failed`
   - Analyze failures
   - Fix issues locally
   - Run tests: `npm test`
   - Commit fixes:
     ```bash
     git add .
     git commit -m "fix(ci): resolve CI failures for epic-17"
     ```
   - Push:
     ```bash
     git push
     ```
   - **If pre-push hook fails**: Fix, commit, push again
   - **Run `/clear`** and return to step 1

4. **If passed**: Proceed to Phase 9

5. **Run `/clear`** to reset context

## Phase 9: Merge PR

**Check**: PR exists, CI passing, ready to merge

1. Verify checks passing:
   ```bash
   gh pr checks
   ```

2. Merge PR:
   ```bash
   gh pr merge --squash --delete-branch
   ```

3. Update local main:
   ```bash
   git checkout main && git pull origin main
   ```

4. Verify merge:
   ```bash
   git log --oneline -5
   ```

5. **Output completion promise**:
   ```
   <promise>EPIC_17_COMPLETE</promise>
   ```

## Error Handling

**If stuck on same phase for 5+ iterations**:
1. Create blocker doc: `docs/stories/17-blocker.md`
2. Document what was attempted
3. Suggest alternatives
4. Output: `<promise>EPIC_17_BLOCKED</promise>`

## Git Hook Failure Protocol

When pre-push hook fails:

1. **READ the error carefully** - hooks exist to catch issues
2. **Run the failing command manually** (e.g., `npm test`, `npm run lint`, `npm run build`)
3. **Fix ALL reported issues** - don't skip any
4. **Stage fixes**: `git add .`
5. **Commit fixes**: `git commit -m "fix: resolve hook failures - {description}"`
6. **Push again**: `git push`
7. **Repeat until successful** - hooks must pass before continuing

**NEVER**:
- Skip hooks with `--no-verify`
- Force push with `--force`
- Ignore hook failures

## Rules

- ALWAYS check git log first to determine current phase
- ALWAYS commit after completing a phase
- ALWAYS push after committing
- ALWAYS fix pre-push hook failures completely
- ALWAYS run `/clear` after successful push
- NEVER skip phases
- NEVER commit with failing tests
- NEVER bypass git hooks" --max-iterations 100 --completion-promise "EPIC_17_COMPLETE"
COMMAND

echo ""
echo "==================================="
echo "NOTE: This version clears context between phases."
echo "Git history is used to track progress."
echo "Each phase commits and pushes before clearing."
echo "==================================="
