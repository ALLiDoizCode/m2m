# Epic 16: AI Agent Node — Vercel AI SDK Integration

## Executive Summary

Epic 16 integrates the Vercel AI SDK to make the M2M agent node AI-native. The AI agent uses **agent skills** — modular capabilities mapped to Nostr event kinds — to process events, compose responses, and route packets. Each skill wraps an existing handler as an AI SDK `tool()` with a description, Zod schema, and execute function. The AI agent orchestrates which skills to invoke based on the incoming event.

AI dispatch is enabled by default. Direct handler dispatch (from Epic 13) serves as a fallback when the AI is unavailable (budget exhausted, API error) or explicitly disabled.

## Architecture

### Processing Flow

```
ILP Packet → TOON Decode → Payment Validation → AI Agent
  ├─ Agent has skill for event kind → Skill execution → ILP Fulfill
  ├─ Agent decides to forward → forward_packet skill → ILP Fulfill/Reject
  ├─ Agent has no matching skill → Reasoned ILP Reject
  └─ Fallback (budget exhausted / API error / AI disabled) → Direct Handler Dispatch
```

### Key Design Decisions

1. **AI is the default** — AI dispatch is enabled by default. Set `ai.enabled: false` for direct dispatch only.
2. **Agent skills = AI SDK tools** — Each Nostr event kind handler is registered as an AI SDK `tool()`.
3. **`generateText` not `streamText`** — ILP packets need complete responses; streaming adds no value.
4. **Payment validation before AI** — No tokens spent on underpaid events.
5. **Provider-agnostic** — Any AI SDK provider works (Anthropic, OpenAI, Google, etc.).
6. **Skills are extensible** — Future NIPs register new skills without changing core agent code.
7. **Token budget with auto-fallback** — Rolling window budget; exhaustion triggers fallback.

## Package Structure

```
packages/connector/src/agent/ai/
├── index.ts
├── ai-agent-dispatcher.ts       # Core AI agent dispatcher
├── ai-agent-config.ts           # Config types and validation
├── provider-factory.ts          # Creates AI SDK model from provider:model string
├── skill-registry.ts            # Skill registration and management
├── system-prompt.ts             # System prompt builder
├── token-budget.ts              # Token budget tracking
├── skills/                      # Agent skills (one per event kind)
│   ├── index.ts                 # Registers all built-in skills
│   ├── store-note-skill.ts      # Kind 1
│   ├── update-follow-skill.ts   # Kind 3
│   ├── delete-events-skill.ts   # Kind 5
│   ├── query-events-skill.ts    # Kind 10000
│   ├── forward-packet-skill.ts  # Packet forwarding
│   └── get-agent-info-skill.ts  # Agent introspection
└── __tests__/
    ├── ai-agent-dispatcher.test.ts
    ├── skill-registry.test.ts
    ├── token-budget.test.ts
    ├── system-prompt.test.ts
    └── integration.test.ts
```

## Configuration

```yaml
ai:
  enabled: true
  model: 'anthropic:claude-haiku-4-5'
  apiKey: '${AI_API_KEY}'
  maxTokensPerRequest: 1024
  budget:
    maxTokensPerHour: 100000
    fallbackOnExhaustion: true
  personality:
    name: 'Agent Alice'
    role: 'Network relay and storage service'
    instructions: 'Be concise. Prefer local handling over forwarding.'
```

## Stories

| Story | Description                                          | Status      |
| ----- | ---------------------------------------------------- | ----------- |
| 16.1  | AI SDK Foundation & Provider Factory                 | Draft       |
| 16.2  | Skill Registry & Built-in Agent Skills               | Not Started |
| 16.3  | System Prompt & Agent Personality                    | Not Started |
| 16.4  | AI Agent Dispatcher                                  | Not Started |
| 16.5  | Token Budget & Cost Management                       | Not Started |
| 16.6  | Architecture Documentation & Skill Development Guide | Not Started |
| 16.7  | Integration Tests                                    | Not Started |

## Dependencies

- **Epic 13** (Agent Society Protocol) — required
- **npm packages:** `ai` ^4.0.0, `zod` ^3.23.0, `@ai-sdk/anthropic` ^1.0.0, `@ai-sdk/openai` ^1.0.0

## Test Results

_To be populated after story implementation._

## Risk Mitigation

| Risk                           | Mitigation                                                       |
| ------------------------------ | ---------------------------------------------------------------- |
| AI latency exceeds ILP timeout | Fast models (Haiku/GPT-4o-mini); 10s timeout; auto-fallback      |
| Token costs escalate           | Rolling-window budget with hard limits; auto-fallback; telemetry |
| AI selects wrong skill         | Clear skill descriptions; decision framework in system prompt    |
| Provider API down              | Auto-fallback to direct dispatch                                 |
| Provider-specific quirks       | AI SDK abstracts differences                                     |
