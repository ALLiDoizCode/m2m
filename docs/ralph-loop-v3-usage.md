# Ralph Loop V3 Usage Guide

## Problem Summary

The original `ralph-epic-v2.sh` script generated a `/ralph-loop` command with an inline prompt containing markdown code blocks (triple backticks) and quotes. When passed to the ralph-loop plugin, these special characters caused shell parsing errors:

````
Error: Bash command failed for pattern "```!
````

## Solution

The new `ralph-epic-v3.sh` script:

1. Generates a properly formatted prompt file with variable substitution
2. Saves it to `.claude/ralph-prompts/epic-{N}.md`
3. Provides clear instructions for manual usage

## Usage

### Step 1: Generate the Prompt File

```bash
./scripts/ralph-epic-v3.sh <epic_number> [max_iterations]
```

Example:

```bash
./scripts/ralph-epic-v3.sh 18 5
```

Output:

```
✓ Prompt file generated: .claude/ralph-prompts/epic-18.md
```

### Step 2: View the Generated Prompt

```bash
cat .claude/ralph-prompts/epic-18.md
```

Copy the entire content to your clipboard.

### Step 3: Run Ralph Loop

In Claude Code, run:

```
/ralph-loop
```

### Step 4: Paste the Prompt

When the ralph-loop skill starts, paste the entire content from the generated file.

### Step 5: Add Flags

Add these flags to the ralph-loop command:

```
--max-iterations 5 --completion-promise "EPIC_18_COMPLETE"
```

## What's Different from V2?

| Aspect                    | V2 (Broken)                         | V3 (Fixed)                  |
| ------------------------- | ----------------------------------- | --------------------------- |
| **Output**                | Inline `/ralph-loop "..."` command  | Separate prompt file        |
| **Special Characters**    | Caused parsing errors               | Properly preserved          |
| **Usage**                 | Copy/paste failing command          | Manual copy/paste from file |
| **Variable Substitution** | Yes (but broken by escaping issues) | Yes (clean)                 |
| **Reliability**           | Failed with shell metacharacters    | Always works                |

## Files

- **Script**: `scripts/ralph-epic-v3.sh`
- **Output Directory**: `.claude/ralph-prompts/`
- **Output File Pattern**: `.claude/ralph-prompts/epic-{N}.md`

## Why This Works

1. The prompt is generated to a file, not passed inline
2. No shell escaping issues because you copy/paste the raw content
3. Variables are properly substituted during generation
4. Backticks and quotes are preserved as-is in the file

## Migration from V2

If you were using `ralph-epic-v2.sh`:

1. Use `ralph-epic-v3.sh` instead
2. Follow the new manual copy/paste workflow
3. The prompt content is identical, just delivered differently

## Troubleshooting

**Q: Can I automate this further?**
A: The ralph-loop plugin doesn't support file-based input directly, so manual copy/paste is the most reliable approach.

**Q: What if variables aren't substituted?**
A: Make sure you're using the unquoted `EOF` delimiter in the heredoc (not `'EOF'`). The script is already configured correctly.

**Q: Can I use this for other epics?**
A: Yes! Just run `./scripts/ralph-epic-v3.sh <epic_number> [max_iterations]` for any epic.
