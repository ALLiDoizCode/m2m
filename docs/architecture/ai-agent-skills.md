# AI Agent Skills Architecture

## Overview

The AI Agent system (Epic 16) makes the M2M agent node AI-native by integrating the Vercel AI SDK. The AI agent uses **agent skills** — modular capabilities mapped to Nostr event kinds — to process events, compose responses, and route packets. Each skill encapsulates the logic for a specific event kind, and the AI agent orchestrates which skills to invoke based on the incoming event.

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────┐
│                      AgentNode                           │
│                                                          │
│  ┌────────────────┐   ┌─────────────────────────────┐   │
│  │ Payment        │   │ AI Agent Dispatcher          │   │
│  │ Validator      │──►│ (Vercel AI SDK generateText) │   │
│  │ (unchanged)    │   │                              │   │
│  └────────────────┘   │  System Prompt               │   │
│                       │  + Event Context              │   │
│                       │         │                     │   │
│                       │  ┌──────▼──────────────┐     │   │
│                       │  │ Agent Skills         │     │   │
│                       │  │ ┌──────┐ ┌────────┐ │     │   │
│                       │  │ │Note  │ │Follow  │ │     │   │
│                       │  │ │Skill │ │Skill   │ │     │   │
│                       │  │ ├──────┤ ├────────┤ │     │   │
│                       │  │ │Delete│ │Query   │ │     │   │
│                       │  │ │Skill │ │Skill   │ │     │   │
│                       │  │ ├──────┤ ├────────┤ │     │   │
│                       │  │ │Fwd   │ │Info    │ │     │   │
│                       │  │ │Skill │ │Skill   │ │     │   │
│                       │  │ └──────┘ └────────┘ │     │   │
│                       │  └─────────────────────┘     │   │
│                       └──────────────┬───────────────┘   │
│                                      │                    │
│                       ┌──────────────▼───────────────┐   │
│                       │ Fallback: Direct Dispatch     │   │
│                       │ (AgentEventHandler - Epic 13) │   │
│                       └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Event Processing Flow

```
ILP Packet → TOON Decode → Payment Validation → AI Agent
  ├─ Agent has skill for event kind → Skill execution → ILP Fulfill
  ├─ Agent decides to forward → forward_packet skill → ILP Fulfill/Reject
  ├─ Agent has no matching skill → Reasoned ILP Reject
  └─ Fallback (budget exhausted / API error / AI disabled) → Direct Handler Dispatch
```

## Core Components

### AIAgentDispatcher

The central orchestrator. Receives an `EventHandlerContext`, builds a system prompt with event details, and calls `generateText()` with registered skills as AI SDK tools. Falls back to direct `AgentEventHandler` dispatch on error.

**Location:** `packages/connector/src/agent/ai/ai-agent-dispatcher.ts`

### SkillRegistry

Manages skill registration and converts skills to AI SDK `tool()` definitions for `generateText()`. Supports dynamic registration for extensibility.

**Location:** `packages/connector/src/agent/ai/skill-registry.ts`

### SystemPromptBuilder

Constructs the system prompt defining the agent's identity, available skills, protocol context, and decision framework. Appends dynamic event context per request.

**Location:** `packages/connector/src/agent/ai/system-prompt.ts`

### TokenBudget

Rolling-window token budget tracker. Enforces hourly cost limits and emits telemetry at 80%/95% thresholds. Auto-falls back to direct dispatch when exhausted.

**Location:** `packages/connector/src/agent/ai/token-budget.ts`

## How to Create a New Agent Skill

This guide walks through creating a new skill for a specific Nostr event kind (NIP).

### Step 1: Create the Skill File

Create a new file in `packages/connector/src/agent/ai/skills/`:

```typescript
// packages/connector/src/agent/ai/skills/my-new-skill.ts

import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';

// Step 2: Define the Zod input schema
const MyNewSkillParams = z.object({
  reason: z.string().describe('Brief reason for invoking this skill'),
  // Add any additional parameters the AI should provide
});

// Step 3: Create and export the skill factory function
export function createMyNewSkill(): AgentSkill<typeof MyNewSkillParams> {
  return {
    name: 'my_new_skill',

    // Step 4: Write a clear tool description
    // This is what the AI reads to decide when to use the skill.
    // Be specific about WHEN to use it and what it does.
    description:
      'Process a Kind XXXX event that does Y. ' +
      'Use this when receiving a valid Kind XXXX Nostr event. ' +
      'The event content contains Z.',

    parameters: MyNewSkillParams,

    // Associate with event kind(s)
    eventKinds: [
      /* your kind number */
    ],

    // Step 5: Implement the execute function
    execute: async (
      params: z.infer<typeof MyNewSkillParams>,
      context: SkillExecuteContext
    ): Promise<EventHandlerResult> => {
      // Access the event, database, and other context
      const { event, database, agentPubkey } = context;

      // Implement your handler logic here
      // This should mirror what an existing handler does

      // Return success with optional response events
      return {
        success: true,
        // responseEvent: { ... },     // Single response
        // responseEvents: [ ... ],    // Multiple responses
      };

      // Or return failure
      // return {
      //   success: false,
      //   error: { code: 'F99', message: 'Reason' },
      // };
    },
  };
}
```

### Step 6: Register the Skill

Add your skill to `packages/connector/src/agent/ai/skills/index.ts`:

```typescript
import { createMyNewSkill } from './my-new-skill';

export function registerBuiltInSkills(registry: SkillRegistry, config: RegisterSkillsConfig): void {
  // ... existing skills ...
  registry.register(createMyNewSkill());
}

export { createMyNewSkill } from './my-new-skill';
```

### Step 7: Write Tests

Create a test file verifying your skill's execute function:

```typescript
// packages/connector/src/agent/ai/__tests__/my-new-skill.test.ts

it('should handle Kind XXXX events correctly', async () => {
  const registry = new SkillRegistry();
  registerBuiltInSkills(registry, {
    /* config */
  });

  const skill = registry.get('my_new_skill')!;
  const context = createSkillContext({ kind: XXXX, content: '...' });

  const result = await skill.execute({ reason: 'test' }, context);
  expect(result.success).toBe(true);
});
```

## Skill Anatomy (Annotated Example)

Here's the `store_note` skill annotated:

```typescript
import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';
import { DatabaseSizeExceededError } from '../../event-database';

// Zod schema — defines what the AI passes to this skill.
// Keep it minimal. The AI doesn't need to pass event data
// (that's already in the context).
const StoreNoteParams = z.object({
  reason: z.string().describe('Brief reason for storing this note'),
});

export function createStoreNoteSkill(): AgentSkill<typeof StoreNoteParams> {
  return {
    name: 'store_note', // Unique name — used as tool name

    // Description is critical — it's what the AI reads to decide
    // whether to invoke this skill. Be clear about:
    // 1. WHAT it does
    // 2. WHEN to use it (which event kind)
    // 3. WHERE the data comes from
    description:
      'Store a Kind 1 text note event in the local event database. ' +
      'Use this skill when receiving a valid Kind 1 Nostr event that ' +
      'should be persisted. The note content and metadata are taken ' +
      'from the incoming event context.',

    parameters: StoreNoteParams,

    eventKinds: [1], // Maps to Nostr Kind 1

    // Execute receives the AI's params + full handler context
    execute: async (_params, context): Promise<EventHandlerResult> => {
      try {
        // Reuses existing handler logic — just call the database
        await context.database.storeEvent(context.event);
        return { success: true };
      } catch (error) {
        // Handle known errors gracefully
        if (error instanceof DatabaseSizeExceededError) {
          return {
            success: false,
            error: { code: 'T00', message: 'Storage limit exceeded' },
          };
        }
        throw error; // Unknown errors propagate to dispatcher
      }
    },
  };
}
```

## Configuration Reference

The `ai` section in agent YAML configuration:

```yaml
ai:
  # Whether AI dispatch is enabled (default: true)
  enabled: true

  # Model in provider:model format
  # Supported providers: anthropic, openai
  model: 'anthropic:claude-haiku-4-5'

  # API key (or use AI_API_KEY environment variable)
  apiKey: '${AI_API_KEY}'

  # Max tokens per AI request (default: 1024)
  maxTokensPerRequest: 1024

  # Token budget for cost management
  budget:
    # Max tokens in a rolling 1-hour window (default: 100000)
    maxTokensPerHour: 100000
    # Fall back to direct dispatch when exhausted (default: true)
    fallbackOnExhaustion: true

  # Optional agent personality
  personality:
    name: 'Agent Alice'
    role: 'Network relay and storage service'
    instructions: 'Be concise. Prefer local handling over forwarding.'
```

### Environment Variable Overrides

| Variable                    | Description                 | Default                      |
| --------------------------- | --------------------------- | ---------------------------- |
| `AI_API_KEY`                | API key for the AI provider | —                            |
| `AI_AGENT_ENABLED`          | Override `ai.enabled`       | `true`                       |
| `AI_AGENT_MODEL`            | Override `ai.model`         | `anthropic:claude-haiku-4-5` |
| `AI_MAX_TOKENS_PER_REQUEST` | Override per-request limit  | `1024`                       |
| `AI_MAX_TOKENS_PER_HOUR`    | Override hourly budget      | `100000`                     |

## Decision Framework: New Skill vs. Extend Existing

| Create a new skill when...             | Extend an existing skill when...            |
| -------------------------------------- | ------------------------------------------- |
| Handling a new Nostr event kind        | Adding a variant to an existing kind        |
| The logic is fundamentally different   | The logic is similar with minor differences |
| A separate AI decision point is needed | The same decision applies                   |
| Different parameters are required      | Parameters are compatible                   |

## Built-in Skills Reference

| Skill            | Event Kind(s) | Description                                  |
| ---------------- | ------------- | -------------------------------------------- |
| `store_note`     | Kind 1        | Store text notes in the event database       |
| `update_follow`  | Kind 3        | Update follow graph and routing table        |
| `delete_events`  | Kind 5        | Delete events (with authorship verification) |
| `query_events`   | Kind 10000    | Query the event database with NIP-01 filters |
| `forward_packet` | —             | Forward an event to a peer via routing table |
| `get_agent_info` | —             | Return agent capabilities and peer info      |
