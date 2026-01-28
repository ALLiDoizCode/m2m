# BMAD Ralph Loop: Epic Development Cycle

Execute the complete BMAD development cycle for an epic autonomously.

## Configuration

- **Epic**: {{EPIC_NUMBER}}
- **Epic PRD**: docs/prd/{{EPIC_PRD_FILE}}
- **Branch Pattern**: epic-{{EPIC_NUMBER}}

## Phase 0: Branch Setup (Once Per Epic)

**CRITICAL**: Always start from an up-to-date main branch.

1. Switch to main and sync with remote:
   ```bash
   git checkout main
   git fetch origin
   git pull origin main
   ```

2. Create or checkout the epic branch:
   ```bash
   git checkout -b epic-{{EPIC_NUMBER}}
   ```
   Or if branch exists:
   ```bash
   git checkout epic-{{EPIC_NUMBER}}
   git rebase main  # Keep epic branch up to date with main
   ```

3. Confirm branch is ready with `git status`

## Phase 1: Story Creation (SM Agent)

**Persona**: Adopt SM agent from `.bmad-core/agents/sm.md`

1. Load `.bmad-core/core-config.yaml`
2. Check `docs/stories/` for existing stories in Epic {{EPIC_NUMBER}}
3. If all stories complete OR no stories exist:
   - Execute `.bmad-core/tasks/create-next-story.md` for Epic {{EPIC_NUMBER}}
   - Create story file in `docs/stories/{{EPIC_NUMBER}}.{N}.story.md`
4. If story creation fails or epic has no more stories:
   - Proceed to Phase 7 (Push & PR)

**Exit Condition**: Story file exists with Status: Draft

## Phase 2: Story Validation (PO Agent)

**Persona**: Adopt PO agent from `.bmad-core/agents/po.md`

1. Execute `.bmad-core/tasks/validate-next-story.md` on the draft story
2. Review the validation report:
   - **GO**: Proceed to Phase 3
   - **NO-GO**: Return to Phase 1, fix issues in story draft
3. Update story Status to "Approved" if validation passes

**Exit Condition**: Validation report shows GO, story Status: Approved

## Phase 3: Implementation (Dev Agent)

**Persona**: Adopt Dev agent from `.bmad-core/agents/dev.md`

1. Load dev context files from `.bmad-core/core-config.yaml` → `devLoadAlwaysFiles`
2. Read the approved story file
3. Implement all Tasks/Subtasks sequentially:
   - Write code following architecture docs
   - Write tests (TDD approach)
   - Run tests after each significant change: `npm test` or project-specific command
   - Fix any failing tests before proceeding
4. Update story sections (Dev Agent Record, File List, Change Log)
5. Run final validation:
   - `npm run lint` (or project linter)
   - `npm test` (all tests must pass)
   - `npm run build` (if applicable)
6. Update story Status to "Review"

**Exit Condition**: All tests pass, story Status: Review

## Phase 4: QA Review (QA Agent)

**Persona**: Adopt QA agent from `.bmad-core/agents/qa.md`

1. Execute `.bmad-core/tasks/review-story.md` on the story
2. Perform comprehensive review:
   - Requirements traceability
   - Code quality assessment
   - Test architecture evaluation
   - NFR validation
3. Create gate file in `docs/qa/gates/`
4. Update QA Results section in story
5. Determine gate status:
   - **PASS**: Proceed to Phase 6 (Commit)
   - **CONCERNS**: Proceed to Phase 5 (Apply Fixes)
   - **FAIL**: Proceed to Phase 5 (Apply Fixes)

**Exit Condition**: Gate file created, QA Results updated

## Phase 5: Apply QA Fixes (Dev Agent)

**Persona**: Adopt Dev agent from `.bmad-core/agents/dev.md`

1. Execute `.bmad-core/tasks/apply-qa-fixes.md` for the story
2. Address issues in priority order:
   - High severity issues first
   - NFR failures
   - Coverage gaps
   - Medium/low severity issues
3. Run validation:
   - `npm run lint`
   - `npm test`
4. Update story (allowed sections only)
5. Set Status based on fixes:
   - All critical issues resolved → "Ready for Review"
   - Return to Phase 4 for re-review

**Exit Condition**: All critical issues addressed, tests pass

## Phase 6: Commit and Loop

1. Verify all tests pass: `npm test`
2. Verify lint passes: `npm run lint`
3. Stage changes: `git add -A`
4. Commit with message:
   ```
   feat(epic-{{EPIC_NUMBER}}): complete story {{STORY_ID}} - {{STORY_TITLE}}

   - Implements all acceptance criteria
   - QA gate: {{GATE_STATUS}}
   - All tests passing

   Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
   ```
5. Update story Status to "Done"
6. Check if more stories remain in epic:
   - **Yes**: Return to Phase 1 for next story
   - **No**: Proceed to Phase 7 (Push & PR)

## Phase 7: Push and Create PR

1. Push branch to remote:
   ```bash
   git push -u origin epic-{{EPIC_NUMBER}}
   ```

2. Create Pull Request using gh CLI:
   ```bash
   gh pr create --title "Epic {{EPIC_NUMBER}}: {{EPIC_TITLE}}" --body "$(cat <<'EOF'
   ## Summary
   - Implements Epic {{EPIC_NUMBER}}: {{EPIC_TITLE}}
   - All stories completed and QA approved
   - See individual story files in docs/stories/{{EPIC_NUMBER}}.*.story.md

   ## Stories Completed
   [List all completed stories]

   ## Test Plan
   - All unit tests passing
   - All integration tests passing
   - QA gates passed for all stories

   🤖 Generated with [Claude Code](https://claude.ai/code)
   EOF
   )"
   ```

3. Proceed to Phase 8 to monitor CI

**Exit Condition**: PR created successfully

## Phase 8: Fix CI Issues

Monitor and fix any CI failures:

1. Check CI status:
   ```bash
   gh pr checks
   ```
   Or:
   ```bash
   gh run list --branch epic-{{EPIC_NUMBER}} --limit 5
   ```

2. If CI is still running, wait and check again

3. If CI failed:
   - Run: `gh run view --log-failed` to get failure logs
   - Analyze the failures and identify root cause
   - Make necessary code fixes
   - Run relevant tests locally to verify fix
   - Commit with message: `fix(ci): [description of fix]`
   - Push: `git push`
   - Return to step 1 to monitor again

4. If CI passed:
   - Proceed to Phase 9 (Merge PR)

**Exit Condition**: All CI checks passing

## Phase 9: Merge PR to Main

Once CI is green, merge the PR:

1. Verify all checks are passing:
   ```bash
   gh pr checks
   ```

2. Merge the PR using squash merge:
   ```bash
   gh pr merge --squash --delete-branch
   ```

3. Update local main branch:
   ```bash
   git checkout main
   git pull origin main
   ```

4. Verify merge was successful:
   ```bash
   git log --oneline -5
   ```

5. Output: `<promise>EPIC_{{EPIC_NUMBER}}_COMPLETE</promise>`

**Exit Condition**: PR merged, local main updated

## Completion Criteria

Output `<promise>EPIC_{{EPIC_NUMBER}}_COMPLETE</promise>` when:
- All stories in Epic {{EPIC_NUMBER}} are Status: Done
- PR has been created
- CI is passing
- PR has been merged to main
- Local main is synced with remote

## Error Handling

If stuck for more than 5 iterations on the same phase:
1. Document the blocker in a file: `docs/stories/{{EPIC_NUMBER}}-blocker.md`
2. List what was attempted
3. Suggest alternative approaches
4. Output: `<promise>EPIC_{{EPIC_NUMBER}}_BLOCKED</promise>`

## Rules

- NEVER skip validation phases
- NEVER commit with failing tests
- NEVER modify files outside allowed sections for each agent
- NEVER create branches from stale main - always fetch and pull first
- ALWAYS cite source documents in Dev Notes
- ALWAYS run tests after code changes
- ALWAYS create gate files for QA reviews
- ALWAYS push and create PR when epic is complete
- ALWAYS fix CI failures before merging
- ALWAYS merge PR and sync main when complete
