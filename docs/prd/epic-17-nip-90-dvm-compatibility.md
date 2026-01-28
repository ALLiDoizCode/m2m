# Epic 17: NIP-90 DVM Compatibility & Agent Task Delegation

## Executive Summary

Epic 17 migrates the M2M agent's service architecture to NIP-90 Data Vending Machine (DVM) patterns, establishing ecosystem compatibility with the broader Nostr agent ecosystem. This includes structured task delegation between agents, which is implemented as DVM job types rather than a separate protocol.

The current Kind 10000 query service will be refactored to use the NIP-90 job marketplace model (kinds 5000-6999) where agents receive job requests and return results. Task delegation between agents uses Kind 5900 (within the DVM range) for structured multi-agent workflows.

This epic is **CRITICAL** as it establishes the foundational patterns for all agent-to-agent service interactions.

## Architecture

### NIP-90 DVM Pattern

```
Client Agent                         Service Agent
      │                                    │
      │  Job Request (Kind 5XXX)           │
      │  + ILP PREPARE (amount)            │
      │─────────────────────────────────────>
      │                                    │
      │  Job Status (Kind 7000) [optional] │
      │<─────────────────────────────────────
      │                                    │
      │  Job Result (Kind 6XXX)            │
      │  + ILP FULFILL                     │
      │<─────────────────────────────────────
```

### M2M Integration

```
ILP PREPARE (amount) → TOON Decode → DVM Job Request (Kind 5XXX)
        ↓
  Payment Validation (existing EventHandler._validatePayment)
        ↓
  Skill Execution (registered for Kind 5XXX)
        ↓
  DVM Job Result (Kind 6XXX)
        ↓
ILP FULFILL → TOON Encode Result
```

**Note:** Payment validation already exists in `EventHandler._validatePayment()`. The ILP PREPARE `amount` field IS the payment — no separate "bid" validation needed. The `bid` tag in DVM requests is informational and should match `packet.amount`.

### Kind Allocation

| Kind Range | Purpose                                  | NIP-90 Standard |
| ---------- | ---------------------------------------- | --------------- |
| 5000-5999  | Job Requests (including task delegation) | Yes             |
| 6000-6999  | Job Results (request kind + 1000)        | Yes             |
| 7000       | Job Feedback/Status                      | Yes             |

### Specific Kind Assignments

| Kind      | Purpose               | Description                             |
| --------- | --------------------- | --------------------------------------- |
| 5000      | General Query         | Migrated from Kind 10000                |
| 5100      | Translation           | Text translation service                |
| 5200      | Summarization         | Text summarization service              |
| 5900      | Agent Task Delegation | Structured task requests between agents |
| 6000-6900 | Corresponding Results | Result kind = request kind + 1000       |
| 7000      | Job Feedback          | Status updates for all job types        |

### Migration Plan

| Current    | Migrated To        | Purpose                |
| ---------- | ------------------ | ---------------------- |
| Kind 10000 | Kind 5000          | General query service  |
| Kind 1     | Kind 1 (unchanged) | Note storage (not DVM) |
| Kind 3     | Kind 3 (unchanged) | Follow list (not DVM)  |
| N/A (new)  | Kind 5900          | Agent task delegation  |

## Package Structure

```
packages/connector/src/agent/
├── dvm/
│   ├── index.ts
│   ├── dvm-job-parser.ts         # Parse Kind 5XXX job requests
│   ├── dvm-result-formatter.ts   # Format Kind 6XXX job results
│   ├── dvm-feedback.ts           # Kind 7000 job feedback/status
│   ├── dvm-kinds.ts              # DVM kind constants and mappings
│   ├── task-delegation.ts        # Kind 5900 task delegation logic
│   └── types.ts                  # Shared DVM types
├── ai/skills/
│   ├── dvm-query-skill.ts        # Kind 5000 (migrated from Kind 10000)
│   ├── dvm-task-skill.ts         # Kind 5900 task delegation
│   └── delegate-task-skill.ts    # AI skill to delegate to peers
└── __tests__/
    └── dvm/
        ├── dvm-job-parser.test.ts
        ├── dvm-result-formatter.test.ts
        ├── task-delegation.test.ts
        └── dvm-integration.test.ts
```

## Configuration

```yaml
agent:
  dvm:
    enabled: true
    supportedKinds:
      - 5000 # General query
      - 5100 # Translation (future)
      - 5200 # Summarization (future)
      - 5900 # Task delegation
    maxInputSize: 65536 # Max input bytes
    timeout: 30 # Default timeout seconds
    taskDelegation:
      enabled: true
      maxRetries: 3
      statusUpdates: true # Emit Kind 7000 updates
```

## Stories

| Story | Description                          | Status      |
| ----- | ------------------------------------ | ----------- |
| 17.1  | DVM Job Request Parser (Kind 5XXX)   | Not Started |
| 17.2  | DVM Job Result Formatter (Kind 6XXX) | Not Started |
| 17.3  | DVM Job Feedback (Kind 7000)         | Not Started |
| 17.4  | Migrate Query Handler to Kind 5000   | Not Started |
| 17.5  | Job Chaining Support                 | Not Started |
| 17.6  | Task Delegation Request (Kind 5900)  | Not Started |
| 17.7  | Task Delegation Result (Kind 6900)   | Not Started |
| 17.8  | Task Status Tracking                 | Not Started |
| 17.9  | Timeout & Retry Logic                | Not Started |
| 17.10 | delegate_task Skill                  | Not Started |
| 17.11 | Integration Tests                    | Not Started |

---

## Story 17.1: DVM Job Request Parser (Kind 5XXX)

### Description

Implement parsing of NIP-90 DVM job requests with support for all standard tags.

### Acceptance Criteria

1. Parser extracts `i` tags (input data with type hints)
2. Parser extracts `output` tag (expected output MIME type)
3. Parser extracts `param` tags (key-value parameters)
4. Parser extracts `bid` tag (informational — actual payment is ILP amount)
5. Parser extracts `relays` tag (relay hints)
6. Parser validates job request structure
7. Parser returns typed `DVMJobRequest` object
8. Invalid requests throw descriptive errors

### Technical Notes

```typescript
interface DVMJobRequest {
  kind: number; // 5000-5999
  inputs: DVMInput[]; // From 'i' tags
  outputType?: string; // From 'output' tag (optional per NIP-90)
  params: Map<string, string>; // From 'param' tags
  bid?: bigint; // From 'bid' tag (optional, informational)
  relays: string[]; // From 'relays' tag
  event: NostrEvent; // Original event
}

interface DVMInput {
  data: string;
  type: 'text' | 'url' | 'event' | 'job';
  relay?: string;
  marker?: string;
}
```

---

## Story 17.2: DVM Job Result Formatter (Kind 6XXX)

### Description

Implement formatting of NIP-90 DVM job results for return to requesters.

### Acceptance Criteria

1. Formatter creates Kind 6XXX events (request kind + 1000)
2. Result includes `request` tag with stringified original request
3. Result includes `e` tag referencing request event ID
4. Result includes `p` tag with requester pubkey
5. Result includes `amount` tag with actual payment received
6. Content field contains result data
7. Formatter handles various content types (text, JSON, binary)
8. Formatter creates unsigned event template ready for signing (signing handled separately by caller)

### Technical Notes

```typescript
interface DVMJobResult {
  kind: number; // 6000-6999 (request kind + 1000)
  requestEvent: NostrEvent;
  content: string;
  amount: bigint; // From ILP packet, not bid tag
  status: 'success' | 'error' | 'partial';
}
```

---

## Story 17.3: DVM Job Feedback (Kind 7000)

### Description

Implement NIP-90 job feedback events for status updates during long-running jobs.

### Acceptance Criteria

1. Feedback event uses Kind 7000
2. Status values: `payment-required`, `processing`, `error`, `success`, `partial`
3. Includes `e` tag referencing job request
4. Includes `p` tag with requester pubkey
5. Includes `amount` tag when payment required
6. Content field contains status message or error details
7. Agent publishes feedback during job lifecycle

### Technical Notes

```typescript
type DVMFeedbackStatus = 'payment-required' | 'processing' | 'error' | 'success' | 'partial';

interface DVMFeedback {
  kind: 7000;
  status: DVMFeedbackStatus;
  jobEventId: string;
  requesterPubkey: string;
  amount?: bigint;
  message?: string;
}
```

---

## Story 17.4: Migrate Query Handler to Kind 5000

### Description

Migrate the existing Kind 10000 query handler to Kind 5000 DVM pattern.

### Acceptance Criteria

1. New `dvm-query-skill.ts` handles Kind 5000 job requests
2. Query parameters extracted from DVM `param` tags
3. Query results returned as Kind 6000 job result
4. Backward compatibility: Kind 10000 still works (deprecated)
5. Skill registered in skill registry for Kind 5000
6. Documentation updated with migration notes
7. Integration tests verify both old and new patterns

### Technical Notes

- Map existing query parameters to DVM `param` tags
- Input data via `i` tag with type `text`
- Results in content field as JSON array
- Pricing uses existing `EventHandler` configuration

---

## Story 17.5: Job Chaining Support

### Description

Enable DVM job chaining where job inputs can reference previous job results.

### Acceptance Criteria

1. Parse `i` tags with type `job` (previous job result)
2. Extract job result from event storage
3. Feed previous result as input to current job
4. Support `e` tags with `dependency` marker
5. Validate dependency chain is complete
6. Error handling for missing dependencies
7. Integration test with chained translation → summarization

### Technical Notes

```json
{
  "kind": 5200,
  "tags": [
    ["i", "", "job", "wss://relay"],
    ["e", "<previous-job-id>", "", "dependency"]
  ],
  "content": "Summarize the translated text"
}
```

---

## Story 17.6: Task Delegation Request (Kind 5900)

### Description

Implement Kind 5900 for structured task delegation between agents. This is a specialized DVM job type for agent-to-agent task requests.

### Acceptance Criteria

1. Parse Kind 5900 events as task delegation requests
2. Support all standard DVM tags plus task-specific tags
3. `timeout` tag specifies max execution time
4. `p` tag can specify preferred agent(s)
5. `priority` tag (high/normal/low)
6. `schema` tag for input/output validation URL
7. Content contains task description/prompt
8. Integration with DVM job parser

### Technical Notes

```typescript
interface TaskDelegationRequest extends DVMJobRequest {
  kind: 5900;
  timeout: number; // From 'timeout' tag (seconds)
  preferredAgents?: string[]; // From 'p' tags
  priority?: 'high' | 'normal' | 'low';
  schema?: string; // From 'schema' tag
}
```

**Event Structure:**

```json
{
  "kind": 5900,
  "tags": [
    ["i", "<input-data>", "text"],
    ["o", "application/json"],
    ["param", "target_language", "es"],
    ["timeout", "30"],
    ["p", "<preferred-agent-pubkey>"],
    ["priority", "normal"]
  ],
  "content": "Translate this text to Spanish"
}
```

---

## Story 17.7: Task Delegation Result (Kind 6900)

### Description

Implement Kind 6900 for task delegation results, extending standard DVM result format.

### Acceptance Criteria

1. Create Kind 6900 events (5900 + 1000)
2. Include standard DVM result tags
3. Add `runtime` tag (execution time in ms)
4. Add `tokens` tag (input/output token counts if applicable)
5. Add `status` tag (success/error/partial)
6. Content contains result data
7. Sign with agent's Nostr key

### Technical Notes

```typescript
interface TaskDelegationResult extends DVMJobResult {
  kind: 6900;
  runtime: number; // From 'runtime' tag (ms)
  tokens?: { input: number; output: number };
  status: 'success' | 'error' | 'partial';
}
```

**Event Structure:**

```json
{
  "kind": 6900,
  "tags": [
    ["e", "<request-event-id>", "", "request"],
    ["p", "<requester-pubkey>"],
    ["status", "success"],
    ["amount", "5000"],
    ["runtime", "1250"],
    ["tokens", "150", "200"]
  ],
  "content": "Hola, ¿cómo estás?"
}
```

---

## Story 17.8: Task Status Tracking

### Description

Implement status tracking for task delegation using Kind 7000 feedback events.

### Acceptance Criteria

1. Emit Kind 7000 when task moves to `processing`
2. Emit Kind 7000 with progress updates for long tasks
3. Include `progress` tag (0-100) when applicable
4. Include `eta` tag (estimated seconds) when applicable
5. Track task state locally for lifecycle management
6. Configurable status update frequency

### Technical Notes

```typescript
type TaskState =
  | 'queued'
  | 'processing'
  | 'waiting'      // Waiting for dependency
  | 'completed'
  | 'failed'
  | 'cancelled';

// Kind 7000 with task-specific tags
{
  "kind": 7000,
  "tags": [
    ["e", "<task-request-id>"],
    ["p", "<requester-pubkey>"],
    ["status", "processing"],
    ["progress", "50"],
    ["eta", "15"]
  ],
  "content": "Processing translation..."
}
```

---

## Story 17.9: Timeout & Retry Logic

### Description

Implement timeout enforcement and retry logic for task delegation.

### Acceptance Criteria

1. Enforce `timeout` tag value during execution
2. Cancel tasks exceeding timeout
3. Return `failed` status with timeout reason via Kind 7000
4. Configurable max retries (default 3)
5. Exponential backoff between retries
6. Track retry count in task metadata
7. Final failure after max retries returns Kind 6900 with error

### Technical Notes

```typescript
class TaskExecutor {
  async execute(request: TaskDelegationRequest): Promise<TaskDelegationResult> {
    const maxRetries = this.config.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const timeoutMs = request.timeout * 1000;
        return await this.executeWithTimeout(request, timeoutMs);
      } catch (error) {
        if (attempt < maxRetries && this.isRetryable(error)) {
          await this.emitRetryStatus(request, attempt);
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw error;
      }
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt), 30000);
  }
}
```

---

## Story 17.10: delegate_task Skill

### Description

Create AI skill enabling agents to delegate tasks to peer agents.

### Acceptance Criteria

1. Skill registered as `delegate_task`
2. Parameters: taskDescription, targetKind, timeout, preferredAgent
3. Discovers capable agents via Epic 18 capability discovery
4. Creates Kind 5900 task request
5. Sends via ILP with appropriate payment
6. Awaits and parses Kind 6900 result
7. Returns result to AI agent
8. Handles timeout and retries
9. Logs delegation decisions

### Technical Notes

```typescript
const delegateTaskSkill: AgentSkill<typeof schema> = {
  name: 'delegate_task',
  description: 'Delegate a task to another agent with the required capability',
  parameters: z.object({
    taskDescription: z.string().describe('Description of the task'),
    targetKind: z.number().describe('Event kind the delegate should support'),
    timeout: z.number().optional().describe('Timeout in seconds'),
    preferredAgent: z.string().optional().describe('ILP address of preferred agent'),
  }),
  execute: async (params, context) => {
    // Discover capable agents (uses Epic 18 infrastructure)
    const candidates = await context.discovery.discoverForKind(params.targetKind);
    const selected = params.preferredAgent
      ? candidates.find((c) => c.ilpAddress === params.preferredAgent)
      : candidates[0];

    if (!selected) {
      throw new NoCapableAgentError(params.targetKind);
    }

    // Create Kind 5900 task request
    const taskEvent = context.dvm.createTaskRequest({
      content: params.taskDescription,
      targetKind: params.targetKind,
      timeout: params.timeout ?? 30,
      preferredAgents: [selected.pubkey],
    });

    // Send via ILP (payment handled by existing infrastructure)
    const result = await context.sendEvent(taskEvent, selected.ilpAddress);
    return context.dvm.parseTaskResult(result);
  },
};
```

---

## Story 17.11: Integration Tests

### Description

Comprehensive integration testing for DVM compatibility and task delegation.

### Acceptance Criteria

1. Test full DVM flow (request → status → result)
2. Test Kind 5000 query migration
3. Test Kind 5900 task delegation between agents
4. Test job chaining with dependencies
5. Test timeout handling
6. Test retry logic
7. Test interop with standard NIP-90 request format
8. Performance benchmarks documented

---

## Dependencies

- **Epic 13** (Agent Society Protocol) — TOON codec, Nostr event handling, ILP integration
- **Epic 16** (AI Agent Node) — Skill registry, AI dispatcher
- **Epic 18** (Capability Discovery) — For delegate_task skill agent discovery
- **NIP-90 Specification** — https://nips.nostr.com/90

## Payment Integration Note

**Payment is handled by existing infrastructure:**

1. ILP PREPARE packet contains `amount` field — this IS the payment
2. `EventHandler._validatePayment()` validates amount before handler execution
3. ILP FULFILL releases the payment upon successful completion
4. ILP REJECT returns payment on failure
5. Settlement occurs via EVM/XRP payment channels (Epic 8, 9)
6. TigerBeetle tracks balances (Epic 6)

The `bid` tag in DVM requests is **informational only** — it should match the ILP packet amount but is not used for payment validation. The existing payment infrastructure handles all economic aspects.

## Risk Mitigation

| Risk                                 | Mitigation                                                |
| ------------------------------------ | --------------------------------------------------------- |
| Breaking existing Kind 10000 clients | Maintain backward compatibility with deprecation warnings |
| DVM ecosystem inconsistencies        | Strict adherence to NIP-90 specification                  |
| Task delegation loops                | Detect cycles via request chain tracking                  |
| Timeout cascades                     | Shorter internal timeouts than external                   |

## Success Metrics

- All existing functionality preserved via Kind 5000
- 100% NIP-90 specification compliance
- Task delegation round-trip < 5s for simple tasks
- Zero regressions in existing tests
- DVM capability events discoverable via NIP-89 queries
