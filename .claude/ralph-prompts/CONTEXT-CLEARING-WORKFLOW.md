# Ralph Loop V2: Context-Clearing Workflow

## What Changed

Ralph Loop V2 introduces **context clearing between phases** to maximize available context window for each phase. This prevents context exhaustion during long epic implementations.

## Key Differences from V1

| Aspect | V1 (Original) | V2 (Context-Clearing) |
|--------|---------------|----------------------|
| **Context** | Accumulates across all phases | Cleared after each phase |
| **Memory** | Conversation history | Git commit history |
| **Commits** | One commit per story | One commit per phase |
| **Pushes** | Push at end of epic | Push after each phase |
| **Hook Handling** | Implicit | Explicit protocol |
| **Phase Detection** | Conversation context | `git log` analysis |

## How It Works

### Phase Execution Cycle

```
1. Ralph Loop starts
   ↓
2. Claude runs: git log --oneline -10
   ↓
3. Analyze commits to determine current phase
   ↓
4. Execute that phase completely
   ↓
5. Commit phase work with descriptive message
   ↓
6. Push to remote (handle any hook failures)
   ↓
7. Run /clear to reset context
   ↓
8. Stop hook intercepts, re-feeds prompt
   ↓
9. Go to step 2 (git log shows new phase)
```

### Phase Detection Logic

Claude examines `git log --oneline -10` output to determine which phase to execute:

- **No epic branch commits** → Phase 0 (Branch Setup)
- **"setup branch"** → Phase 1 (Story Creation)
- **"create story"** → Phase 2 (Validation)
- **"approve story"** → Phase 3 (Implementation)
- **"implement story"** → Phase 4 (QA Review)
- **"qa review" + PASS** → Phase 6 (Complete Story)
- **"qa review" + FAIL** → Phase 5 (Apply Fixes)
- **"apply fixes"** → Phase 4 (Re-review)
- **"complete story" + more stories** → Phase 1 (Next Story)
- **"complete story" + no more stories** → Phase 7 (Create PR)
- **"create PR"** → Phase 8 (Fix CI)
- **PR merged** → Done

## Git Hook Handling Protocol

### Why Hooks Matter

Pre-push hooks protect code quality by running checks before pushing. Ralph V2 **explicitly handles hook failures** rather than bypassing them.

### Hook Failure Response

When `git push` fails due to pre-push hook:

1. **Read error output** - understand what failed (tests, lint, build, etc.)
2. **Run failing command manually** - `npm test`, `npm run lint`, etc.
3. **Fix ALL issues** - don't skip any failures
4. **Stage fixes** - `git add .`
5. **Commit fixes** - `git commit -m "fix: resolve hook failures - {description}"`
6. **Push again** - `git push`
7. **Repeat until successful**

### What NEVER To Do

- ❌ `git push --no-verify` (bypass hooks)
- ❌ `git push --force` (force push)
- ❌ Ignore hook failures
- ❌ Comment out failing tests
- ❌ Disable linting rules to pass

## Commit Message Format

Each phase has a specific commit message format for easy detection:

```bash
# Phase 0
"chore(epic-17): setup branch for nip 90 dvm compatibility"

# Phase 1
"docs(epic-17): create story 17.{N} - {title}"

# Phase 2
"docs(epic-17): approve story 17.{N} after validation"

# Phase 3
"feat(epic-17): implement story 17.{N} - {title}"

# Phase 4
"docs(epic-17): qa review story 17.{N} - status: {PASS/FAIL/CONCERNS}"

# Phase 5
"fix(epic-17): apply qa fixes for story 17.{N}"

# Phase 6
"docs(epic-17): complete story 17.{N} - {title}"

# Phase 7
"chore(epic-17): create PR for epic"

# Phase 8 (CI fixes)
"fix(ci): resolve CI failures for epic-17"

# Hook failures
"fix: resolve hook failures - {description}"
```

## Benefits

### 1. Maximum Context Per Phase

Each phase starts with a **clean slate**, maximizing available context window for:
- Complex implementations (Phase 3)
- Thorough QA reviews (Phase 4)
- Detailed fix applications (Phase 5)

### 2. Reliable State Tracking

Git history is **more reliable** than conversation memory:
- Survives crashes/disconnects
- Visible in GitHub
- Auditable and reviewable
- Can resume from any point

### 3. Granular Progress Visibility

Each phase commit provides:
- Clear progress tracking
- Easy rollback points
- Reviewable intermediate states
- GitHub Actions can trigger on each push

### 4. Hook Compliance

Explicit hook handling ensures:
- Code quality maintained throughout
- Tests pass before pushing
- Linting enforced continuously
- No technical debt accumulation

## Usage

### Generate Command

```bash
./scripts/ralph-epic-v2.sh 17
```

This outputs a `/ralph-loop` command to copy into Claude Code.

### Start Ralph Loop

Paste the generated command into Claude Code and press Enter.

### Monitor Progress

Watch commits in GitHub or locally:

```bash
git log --oneline --graph epic-17
```

### Resume After Interruption

If Ralph is interrupted, just restart the `/ralph-loop` command. Git log will determine the correct phase to resume from.

## Troubleshooting

### "Stuck on same phase"

If Claude repeats the same phase:

1. **Check git log** - verify commit message format
2. **Check story status** - verify Status field is updated
3. **Check for uncommitted changes** - `git status`
4. **Manual commit if needed** - commit with proper message format

### "Pre-push hook keeps failing"

1. **Run tests locally** - `npm test`
2. **Run linting locally** - `npm run lint`
3. **Fix all issues** - don't skip any
4. **Commit fixes** - proper commit message
5. **Try push again**

### "Phase detection wrong"

1. **Check commit messages** - ensure they match format
2. **Check git log output** - `git log --oneline -10`
3. **Manual correction** - make a commit with correct message

### "Context still exhausted"

1. **Break epic into smaller parts** - run multiple Ralph sessions
2. **Simplify phase complexity** - reduce test output verbosity
3. **Manual phase transitions** - `/clear` manually between phases

## Comparison Example

### V1 Workflow (Story-Level Commits)

```
Iteration 1: Create story 17.1 (context: 10K tokens)
Iteration 2: Validate story 17.1 (context: 25K tokens)
Iteration 3: Implement story 17.1 (context: 80K tokens)
Iteration 4: QA review story 17.1 (context: 150K tokens)
Iteration 5: Apply fixes (context: 200K tokens) ← Near limit!
... (Epic continues, context exhaustion likely)
Final: One commit per completed story
```

### V2 Workflow (Phase-Level Commits)

```
Iteration 1: Create story 17.1 → commit → push → /clear (context: RESET)
Iteration 2: Validate story 17.1 → commit → push → /clear (context: RESET)
Iteration 3: Implement story 17.1 → commit → push → /clear (context: RESET)
Iteration 4: QA review story 17.1 → commit → push → /clear (context: RESET)
Iteration 5: Apply fixes → commit → push → /clear (context: RESET)
... (Epic continues, context always fresh)
Final: One commit per phase, never exhausts context
```

## Migration from V1

If you have an epic in progress with V1:

1. **Complete current story** - finish with V1
2. **Switch to V2** - use `ralph-epic-v2.sh` for next story
3. **Git log compatible** - V2 can detect V1 story commits

## Best Practices

1. **Trust the process** - let git log drive phase detection
2. **Fix hooks immediately** - don't defer hook failures
3. **Commit message accuracy** - use exact format for detection
4. **Monitor GitHub** - watch commits appear in real-time
5. **Resume confidently** - git history preserves all state

## When to Use V1 vs V2

### Use V1 (Original) When:
- Small epics (1-2 stories)
- Simple implementations
- No context concerns

### Use V2 (Context-Clearing) When:
- Large epics (5+ stories)
- Complex implementations
- Long QA reviews
- Previous context exhaustion issues
- Want granular commit history

## Technical Details

### /clear Command

The `/clear` command:
- Clears conversation history
- Preserves file system state
- Preserves git repository state
- Resets context window to 0 tokens

### Stop Hook Behavior

The stop hook:
- Intercepts Claude's exit attempt
- Re-feeds the original Ralph prompt
- Does NOT clear context (that's `/clear`'s job)
- Continues loop until completion promise

### Git State Preservation

After `/clear`, Claude can still access:
- All files in working directory
- All git history (`git log`)
- All git branches (`git branch`)
- Remote state (`git remote -v`)
- Story files with updated status

This is how phase continuity is maintained despite context clearing.
